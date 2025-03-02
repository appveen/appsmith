import {
  actionChannel,
  call,
  fork,
  put,
  select,
  take,
  all,
  delay,
} from "redux-saga/effects";

import {
  EvaluationReduxAction,
  ReduxAction,
  ReduxActionType,
  ReduxActionTypes,
  ReduxActionWithoutPayload,
} from "constants/ReduxActionConstants";
import {
  getDataTree,
  getUnevaluatedDataTree,
} from "selectors/dataTreeSelectors";
import { getWidgets } from "sagas/selectors";
import WidgetFactory, { WidgetTypeConfigMap } from "../utils/WidgetFactory";
import { GracefulWorkerService } from "utils/WorkerUtil";
import Worker from "worker-loader!../workers/evaluation.worker";
import {
  EVAL_WORKER_ACTIONS,
  PropertyEvaluationErrorType,
} from "utils/DynamicBindingUtils";
import log from "loglevel";
import { WidgetProps } from "widgets/BaseWidget";
import PerformanceTracker, {
  PerformanceTransactionName,
} from "../utils/PerformanceTracker";
import * as Sentry from "@sentry/react";
import { Action } from "redux";
import {
  EVALUATE_REDUX_ACTIONS,
  FIRST_EVAL_REDUX_ACTIONS,
  setDependencyMap,
  setEvaluatedTree,
  shouldProcessBatchedAction,
} from "actions/evaluationActions";
import {
  evalErrorHandler,
  logSuccessfulBindings,
  postEvalActionDispatcher,
  updateTernDefinitions,
} from "./PostEvaluationSagas";
import { JSAction } from "entities/JSCollection";
import { getAppMode } from "selectors/applicationSelectors";
import { APP_MODE } from "entities/App";
import { get, isUndefined } from "lodash";
import {
  setEvaluatedArgument,
  setEvaluatedSnippet,
  setGlobalSearchFilterContext,
} from "actions/globalSearchActions";
import { executeActionTriggers } from "./ActionExecution/ActionExecutionSagas";
import { EventType } from "constants/AppsmithActionConstants/ActionConstants";
import { Toaster } from "components/ads/Toast";
import { Variant } from "components/ads/common";
import {
  createMessage,
  SNIPPET_EXECUTION_FAILED,
  SNIPPET_EXECUTION_SUCCESS,
} from "constants/messages";
import { validate } from "workers/validations";
import { diff } from "deep-diff";
import { REPLAY_DELAY } from "entities/Replay/replayUtils";
import { EvaluationVersion } from "api/ApplicationApi";
import { makeUpdateJSCollection } from "sagas/JSPaneSagas";
import { ENTITY_TYPE } from "entities/AppsmithConsole";
import { Replayable } from "entities/Replay/ReplayEntity/ReplayEditor";

let widgetTypeConfigMap: WidgetTypeConfigMap;

const worker = new GracefulWorkerService(Worker);

function* evaluateTreeSaga(
  postEvalActions?: Array<ReduxAction<unknown> | ReduxActionWithoutPayload>,
  shouldReplay?: boolean,
) {
  const unevalTree = yield select(getUnevaluatedDataTree);
  const widgets = yield select(getWidgets);
  log.debug({ unevalTree });
  PerformanceTracker.startAsyncTracking(
    PerformanceTransactionName.DATA_TREE_EVALUATION,
  );
  const workerResponse = yield call(
    worker.request,
    EVAL_WORKER_ACTIONS.EVAL_TREE,
    {
      unevalTree,
      widgetTypeConfigMap,
      widgets,
      shouldReplay,
    },
  );
  const {
    dataTree,
    dependencies,
    errors,
    evaluationOrder,
    jsUpdates,
    logs,
    unEvalUpdates,
  } = workerResponse;
  PerformanceTracker.stopAsyncTracking(
    PerformanceTransactionName.DATA_TREE_EVALUATION,
  );
  PerformanceTracker.startAsyncTracking(
    PerformanceTransactionName.SET_EVALUATED_TREE,
  );
  const oldDataTree = yield select(getDataTree);

  const updates = diff(oldDataTree, dataTree) || [];

  yield put(setEvaluatedTree(dataTree, updates));
  PerformanceTracker.stopAsyncTracking(
    PerformanceTransactionName.SET_EVALUATED_TREE,
  );

  const updatedDataTree = yield select(getDataTree);
  log.debug({ jsUpdates: jsUpdates });
  log.debug({ dataTree: updatedDataTree });
  logs?.forEach((evalLog: any) => log.debug(evalLog));
  yield call(evalErrorHandler, errors, updatedDataTree, evaluationOrder);
  const appMode = yield select(getAppMode);
  if (appMode !== APP_MODE.PUBLISHED) {
    yield call(makeUpdateJSCollection, jsUpdates);
    yield fork(
      logSuccessfulBindings,
      unevalTree,
      updatedDataTree,
      evaluationOrder,
    );

    yield fork(updateTernDefinitions, updatedDataTree, unEvalUpdates);
  }

  yield put(setDependencyMap(dependencies));
  if (postEvalActions && postEvalActions.length) {
    yield call(postEvalActionDispatcher, postEvalActions);
  }
}

export function* evaluateActionBindings(
  bindings: string[],
  executionParams: Record<string, any> | string = {},
) {
  const workerResponse = yield call(
    worker.request,
    EVAL_WORKER_ACTIONS.EVAL_ACTION_BINDINGS,
    {
      bindings,
      executionParams,
    },
  );

  const { errors, values } = workerResponse;

  yield call(evalErrorHandler, errors);
  return values;
}

export function* evaluateDynamicTrigger(
  dynamicTrigger: string,
  callbackData?: Array<any>,
) {
  const unEvalTree = yield select(getUnevaluatedDataTree);

  const workerResponse = yield call(
    worker.request,
    EVAL_WORKER_ACTIONS.EVAL_TRIGGER,
    { dataTree: unEvalTree, dynamicTrigger, callbackData },
  );

  const { errors, triggers } = workerResponse;

  yield call(evalErrorHandler, errors);

  return triggers;
}

export function* clearEvalCache() {
  yield call(worker.request, EVAL_WORKER_ACTIONS.CLEAR_CACHE);

  return true;
}

export function* clearEvalPropertyCache(propertyPath: string) {
  yield call(worker.request, EVAL_WORKER_ACTIONS.CLEAR_PROPERTY_CACHE, {
    propertyPath,
  });
}

export function* executeFunction(collectionName: string, action: JSAction) {
  const unEvalTree = yield select(getUnevaluatedDataTree);
  const dynamicTrigger = collectionName + "." + action.name + "()";

  const workerResponse = yield call(
    worker.request,
    EVAL_WORKER_ACTIONS.EVAL_TRIGGER,
    { dataTree: unEvalTree, dynamicTrigger, fullPropertyPath: dynamicTrigger },
  );

  const { errors, result, triggers } = workerResponse;
  yield call(evalErrorHandler, errors);
  return { triggers, result };
}

/**
 * clears all cache keys of a widget
 *
 * @param widgetName
 */
export function* clearEvalPropertyCacheOfWidget(widgetName: string) {
  yield call(
    worker.request,
    EVAL_WORKER_ACTIONS.CLEAR_PROPERTY_CACHE_OF_WIDGET,
    {
      widgetName,
    },
  );
}

export function* validateProperty(
  property: string,
  value: any,
  props: WidgetProps,
) {
  const unevalTree = yield select(getUnevaluatedDataTree);
  const validation = unevalTree[props.widgetName].validationPaths[property];
  return yield call(worker.request, EVAL_WORKER_ACTIONS.VALIDATE_PROPERTY, {
    property,
    value,
    props,
    validation,
  });
}

function evalQueueBuffer() {
  let canTake = false;
  let postEvalActions: any = [];
  const take = () => {
    if (canTake) {
      const resp = postEvalActions;
      postEvalActions = [];
      canTake = false;
      return { postEvalActions: resp, type: "BUFFERED_ACTION" };
    }
  };
  const flush = () => {
    if (canTake) {
      return [take() as Action];
    }

    return [];
  };

  const put = (action: EvaluationReduxAction<unknown | unknown[]>) => {
    if (!shouldProcessBatchedAction(action)) {
      return;
    }
    canTake = true;

    // TODO: If the action is the same as before, we can send only one and ignore duplicates.
    if (action.postEvalActions) {
      postEvalActions.push(...action.postEvalActions);
    }
  };

  return {
    take,
    put,
    isEmpty: () => {
      return !canTake;
    },
    flush,
  };
}

function* evaluationChangeListenerSaga() {
  // Explicitly shutdown old worker if present
  yield call(worker.shutdown);
  yield call(worker.start);
  yield call(worker.request, EVAL_WORKER_ACTIONS.SETUP);
  widgetTypeConfigMap = WidgetFactory.getWidgetTypeConfigMap();
  const initAction = yield take(FIRST_EVAL_REDUX_ACTIONS);
  yield fork(evaluateTreeSaga, initAction.postEvalActions);
  const evtActionChannel = yield actionChannel(
    EVALUATE_REDUX_ACTIONS,
    evalQueueBuffer(),
  );
  while (true) {
    const action: EvaluationReduxAction<unknown | unknown[]> = yield take(
      evtActionChannel,
    );
    if (shouldProcessBatchedAction(action)) {
      yield call(
        evaluateTreeSaga,
        action.postEvalActions,
        get(action, "payload.shouldReplay"),
      );
    }
  }
}

export function* evaluateSnippetSaga(action: any) {
  try {
    let { expression } = action.payload;
    const { dataType, isTrigger } = action.payload;
    if (isTrigger) {
      expression = `function() { ${expression} }`;
    }
    const workerResponse: {
      errors: any;
      result: any;
      triggers: any;
    } = yield call(worker.request, EVAL_WORKER_ACTIONS.EVAL_EXPRESSION, {
      expression,
      dataType,
      isTrigger,
    });
    const { errors, result, triggers } = workerResponse;
    if (triggers && triggers.length > 0) {
      yield all(
        triggers.map((trigger: any) =>
          call(
            executeActionTriggers,
            trigger,
            EventType.ON_SNIPPET_EXECUTE,
            {},
          ),
        ),
      );
      //Result is when trigger is present. Following code will hide the evaluated snippet section
      yield put(setEvaluatedSnippet(result));
    } else {
      /*
        JSON.stringify(undefined) is undefined.
        We need to set it manually to "undefined" for codeEditor to display it.
      */
      yield put(
        setEvaluatedSnippet(
          errors?.length
            ? JSON.stringify(errors, null, 2)
            : isUndefined(result)
            ? "undefined"
            : JSON.stringify(result),
        ),
      );
    }
    Toaster.show({
      text: createMessage(
        errors?.length ? SNIPPET_EXECUTION_FAILED : SNIPPET_EXECUTION_SUCCESS,
      ),
      variant: errors?.length ? Variant.danger : Variant.success,
    });
    yield put(
      setGlobalSearchFilterContext({
        executionInProgress: false,
      }),
    );
  } catch (e) {
    yield put(
      setGlobalSearchFilterContext({
        executionInProgress: false,
      }),
    );
    Toaster.show({
      text: createMessage(SNIPPET_EXECUTION_FAILED),
      variant: Variant.danger,
    });
    log.error(e);
    Sentry.captureException(e);
  }
}

export function* evaluateArgumentSaga(action: any) {
  const { name, type, value } = action.payload;
  try {
    const workerResponse = yield call(
      worker.request,
      EVAL_WORKER_ACTIONS.EVAL_EXPRESSION,
      {
        expression: value,
      },
    );
    const lintErrors = (workerResponse.errors || []).filter(
      (error: any) => error.errorType !== PropertyEvaluationErrorType.LINT,
    );
    if (workerResponse.result) {
      const validation = validate({ type }, workerResponse.result, {});
      if (!validation.isValid)
        validation.messages?.map((message) => {
          lintErrors.unshift({
            ...validation,
            ...{
              errorType: PropertyEvaluationErrorType.VALIDATION,
              errorMessage: message,
            },
          });
        });
    }
    yield put(
      setEvaluatedArgument({
        [name]: {
          type,
          value: workerResponse.result,
          name,
          errors: lintErrors,
          isInvalid: lintErrors.length > 0,
        },
      }),
    );
  } catch (e) {
    log.error(e);
    Sentry.captureException(e);
  }
}

export function* updateReplayEntitySaga(
  actionPayload: ReduxAction<{
    entityId: string;
    entity: Replayable;
    entityType: ENTITY_TYPE;
  }>,
) {
  //Delay updates to replay object to not persist every keystroke
  yield delay(REPLAY_DELAY);
  const { entity, entityId, entityType } = actionPayload.payload;
  const workerResponse = yield call(
    worker.request,
    EVAL_WORKER_ACTIONS.UPDATE_REPLAY_OBJECT,
    {
      entityId,
      entity,
      entityType,
    },
  );
  return workerResponse;
}

export function* workerComputeUndoRedo(operation: string, entityId: string) {
  const workerResponse: any = yield call(worker.request, operation, {
    entityId,
  });
  return workerResponse;
}

export function* setAppVersionOnWorkerSaga(action: {
  type: ReduxActionType;
  payload: EvaluationVersion;
}) {
  const version: EvaluationVersion = action.payload;
  yield call(worker.request, EVAL_WORKER_ACTIONS.SET_EVALUATION_VERSION, {
    version,
  });
}

export default function* evaluationSagaListeners() {
  yield take(ReduxActionTypes.START_EVALUATION);
  while (true) {
    try {
      yield call(evaluationChangeListenerSaga);
    } catch (e) {
      log.error(e);
      Sentry.captureException(e);
    }
  }
}
