import { DataTree } from "entities/DataTree/dataTreeFactory";
import {
  EvaluationError,
  extraLibraries,
  PropertyEvaluationErrorType,
  unsafeFunctionForEval,
} from "utils/DynamicBindingUtils";
import unescapeJS from "unescape-js";
import { Severity } from "entities/AppsmithConsole";
import { AppsmithPromise, enhanceDataTreeWithFunctions } from "./Actions";
import { ActionDescription } from "entities/DataTree/actionTriggers";
import { isEmpty } from "lodash";
import { getLintingErrors } from "workers/lint";

export type EvalResult = {
  result: any;
  triggers?: ActionDescription[];
  errors: EvaluationError[];
};

export enum EvaluationScriptType {
  EXPRESSION = "EXPRESSION",
  ANONYMOUS_FUNCTION = "ANONYMOUS_FUNCTION",
  TRIGGERS = "TRIGGERS",
}

export const ScriptTemplate = "<<string>>";

export const EvaluationScripts: Record<EvaluationScriptType, string> = {
  [EvaluationScriptType.EXPRESSION]: `
  function closedFunction () {
    const result = ${ScriptTemplate}
    return result;
  }
  closedFunction.call(THIS_CONTEXT)
  `,
  [EvaluationScriptType.ANONYMOUS_FUNCTION]: `
  function callback (script) {
    const userFunction = script;
    const result = userFunction?.apply(THIS_CONTEXT, ARGUMENTS);
    return result;
  }
  callback(${ScriptTemplate})
  `,
  [EvaluationScriptType.TRIGGERS]: `
  function closedFunction () {
    const result = ${ScriptTemplate}
    return result
  }
  closedFunction.call(THIS_CONTEXT);
  `,
};

const getScriptType = (
  evalArguments?: Array<any>,
  isTriggerBased = false,
): EvaluationScriptType => {
  let scriptType = EvaluationScriptType.EXPRESSION;
  if (evalArguments) {
    scriptType = EvaluationScriptType.ANONYMOUS_FUNCTION;
  } else if (isTriggerBased) {
    scriptType = EvaluationScriptType.TRIGGERS;
  }
  return scriptType;
};

export const getScriptToEval = (
  userScript: string,
  type: EvaluationScriptType,
): string => {
  // Using replace here would break scripts with replacement patterns (ex: $&, $$)
  const buffer = EvaluationScripts[type].split(ScriptTemplate);
  return `${buffer[0]}${userScript}${buffer[1]}`;
};

export function setupEvaluationEnvironment() {
  ///// Adding extra libraries separately
  extraLibraries.forEach((library) => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: No types available
    self[library.accessor] = library.lib;
  });

  ///// Remove all unsafe functions
  unsafeFunctionForEval.forEach((func) => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: No types available
    self[func] = undefined;
  });
}

const beginsWithLineBreakRegex = /^\s+|\s+$/;

export const createGlobalData = (
  dataTree: DataTree,
  resolvedFunctions: Record<string, any>,
  isTriggerBased: boolean,
  context?: EvaluateContext,
  evalArguments?: Array<any>,
) => {
  const GLOBAL_DATA: Record<string, any> = {};
  ///// Adding callback data
  GLOBAL_DATA.ARGUMENTS = evalArguments;
  //// Adding contextual data not part of data tree
  GLOBAL_DATA.THIS_CONTEXT = {};
  if (context) {
    if (context.thisContext) {
      GLOBAL_DATA.THIS_CONTEXT = context.thisContext;
    }
    if (context.globalContext) {
      Object.entries(context.globalContext).forEach(([key, value]) => {
        GLOBAL_DATA[key] = value;
      });
    }
  }
  ///// Mocking Promise class
  GLOBAL_DATA.Promise = AppsmithPromise;
  if (isTriggerBased) {
    //// Add internal functions to dataTree;
    const dataTreeWithFunctions = enhanceDataTreeWithFunctions(dataTree);
    ///// Adding Data tree with functions
    Object.keys(dataTreeWithFunctions).forEach((datum) => {
      GLOBAL_DATA[datum] = dataTreeWithFunctions[datum];
    });
  } else {
    Object.keys(dataTree).forEach((datum) => {
      GLOBAL_DATA[datum] = dataTree[datum];
    });
  }
  if (!isEmpty(resolvedFunctions)) {
    Object.keys(resolvedFunctions).forEach((datum: any) => {
      const resolvedObject = resolvedFunctions[datum];
      Object.keys(resolvedObject).forEach((key: any) => {
        const dataTreeKey = GLOBAL_DATA[datum];
        if (dataTreeKey) {
          dataTreeKey[key] = resolvedObject[key];
        }
      });
    });
  }
  return GLOBAL_DATA;
};

export function sanitizeScript(js: string) {
  // We remove any line breaks from the beginning of the script because that
  // makes the final function invalid. We also unescape any escaped characters
  // so that eval can happen
  const trimmedJS = js.replace(beginsWithLineBreakRegex, "");
  return self.evaluationVersion > 1 ? trimmedJS : unescapeJS(trimmedJS);
}

/** Define a context just for this script
 * thisContext will define it on the `this`
 * globalContext will define it globally
 */
export type EvaluateContext = {
  thisContext?: Record<string, any>;
  globalContext?: Record<string, any>;
};

export default function evaluate(
  js: string,
  data: DataTree,
  resolvedFunctions: Record<string, any>,
  context?: EvaluateContext,
  evalArguments?: Array<any>,
  isTriggerBased = false,
): EvalResult {
  const sanitizedScript = sanitizeScript(js);

  // If nothing is present to evaluate, return back instead of evaluating
  if (!sanitizedScript.length) {
    return {
      errors: [],
      result: undefined,
      triggers: [],
    };
  }

  const scriptType = getScriptType(evalArguments, isTriggerBased);
  const script = getScriptToEval(sanitizedScript, scriptType);
  // We are linting original js binding,
  // This will make sure that the character count is not messed up when we do unescapejs
  const scriptToLint = getScriptToEval(js, scriptType);

  return (function() {
    let errors: EvaluationError[] = [];
    let result;
    let triggers: any[] = [];
    /**** Setting the eval context ****/
    const GLOBAL_DATA: Record<string, any> = createGlobalData(
      data,
      resolvedFunctions,
      isTriggerBased,
      context,
      evalArguments,
    );

    // Set it to self so that the eval function can have access to it
    // as global data. This is what enables access all appsmith
    // entity properties from the global context
    for (const entity in GLOBAL_DATA) {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore: No types available
      self[entity] = GLOBAL_DATA[entity];
    }
    errors = getLintingErrors(scriptToLint, GLOBAL_DATA, js, scriptType);

    try {
      result = eval(script);
      if (isTriggerBased) {
        triggers = self.triggers.slice();
        self.triggers = [];
      }
    } catch (e) {
      const errorMessage = `${e.name}: ${e.message}`;
      errors.push({
        errorMessage: errorMessage,
        severity: Severity.ERROR,
        raw: script,
        errorType: PropertyEvaluationErrorType.PARSE,
        originalBinding: js,
      });
    }

    if (!isEmpty(resolvedFunctions)) {
      Object.keys(resolvedFunctions).forEach((datum: any) => {
        const resolvedObject = resolvedFunctions[datum];
        Object.keys(resolvedObject).forEach((key: any) => {
          if (resolvedObject[key]) {
            self[datum][key] = resolvedObject[key].toString();
          }
        });
      });
    }
    // Remove it from self
    // This is needed so that next eval can have a clean sheet
    Object.keys(GLOBAL_DATA).forEach((key) => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore: No types available
      delete self[key];
    });

    return { result, triggers, errors };
  })();
}
