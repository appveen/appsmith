package com.appsmith.external.services.ce;

import com.appsmith.external.constants.ConditionalOperator;
import com.appsmith.external.constants.DataType;
import com.appsmith.external.models.Condition;
import com.fasterxml.jackson.databind.node.ArrayNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;


public interface IFilterDataServiceCE {

    ArrayNode filterData(ArrayNode items, List<Condition> conditionList);

    ArrayNode filterDataNew(ArrayNode items, Condition condition);

    List<Map<String, Object>> executeFilterQueryOldFormat(String tableName, List<Condition> conditions, Map<String, DataType> schema);

    void insertAllData(String tableName, ArrayNode items, Map<String, DataType> schema);

    String generateTable(Map<String, DataType> schema);

    void dropTable(String tableName);

    Map<String, DataType> generateSchema(ArrayNode items);

    boolean validConditionList(List<Condition> conditionList, Map<String, DataType> schema);

    String generateLogicalExpression(List<Condition> conditions, LinkedHashMap<String, DataType> values, Map<String, DataType> schema, ConditionalOperator logicOp);

}

