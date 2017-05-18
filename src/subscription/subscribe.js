/**
 * Copyright (c) 2017, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

import { isAsyncIterable } from 'iterall';
import { GraphQLError } from '../error/GraphQLError';
import { locatedError } from '../error/locatedError';
import {
  addPath,
  assertValidExecutionArguments,
  buildExecutionContext,
  buildResolveInfo,
  collectFields,
  execute,
  getFieldDef,
  getOperationRootType,
  resolveFieldValueOrError,
  responsePathAsArray,
} from '../execution/execute';
import { GraphQLSchema } from '../type/schema';
import asyncIteratorReject from './asyncIteratorReject';
import asyncIteratorResolve from './asyncIteratorResolve';
import emptyAsyncIterator from './emptyAsyncIterator';
import mapAsyncIterator from './mapAsyncIterator';

import type { ExecutionResult } from '../execution/execute';
import type { DocumentNode } from '../language/ast';
import type { GraphQLFieldResolver } from '../type/definition';

/**
 * Implements the "Subscribe" algorithm described in the GraphQL specification.
 *
 * Returns an AsyncIterator
 *
 * If the arguments to this function do not result in a legal execution context,
 * the AsyncIterator will yield an GraphQLError explaining the invalid input.
 *
 * Accepts either an object with named arguments, or individual arguments.
 */
declare function subscribe({|
  schema: GraphQLSchema,
  document: DocumentNode,
  rootValue?: mixed,
  contextValue?: mixed,
  variableValues?: ?{[key: string]: mixed},
  operationName?: ?string,
  fieldResolver?: ?GraphQLFieldResolver<any, any>,
  subscribeFieldResolver?: ?GraphQLFieldResolver<any, any>
|}, ..._: []): AsyncIterator<ExecutionResult>;
/* eslint-disable no-redeclare */
declare function subscribe(
  schema: GraphQLSchema,
  document: DocumentNode,
  rootValue?: mixed,
  contextValue?: mixed,
  variableValues?: ?{[key: string]: mixed},
  operationName?: ?string,
  fieldResolver?: ?GraphQLFieldResolver<any, any>,
  subscribeFieldResolver?: ?GraphQLFieldResolver<any, any>
): AsyncIterator<ExecutionResult>;
export function subscribe(
  argsOrSchema,
  document,
  rootValue,
  contextValue,
  variableValues,
  operationName,
  fieldResolver,
  subscribeFieldResolver
) {
  // Extract arguments from object args if provided.
  const args = arguments.length === 1 ? argsOrSchema : undefined;
  const schema = args ? args.schema : argsOrSchema;
  if (args) {
    /* eslint-disable no-param-reassign */
    document = args.document;
    rootValue = args.rootValue;
    contextValue = args.contextValue;
    variableValues = args.variableValues;
    operationName = args.operationName;
    fieldResolver = args.fieldResolver;
    subscribeFieldResolver = args.subscribeFieldResolver;
    /* eslint-enable no-param-reassign, no-redeclare */
  }

  // If arguments are missing or incorrect, throw an error.
  assertValidExecutionArguments(
    schema,
    document,
    variableValues
  );

  let subscription;
  try {
    subscription = createSourceEventStream(
      schema,
      document,
      rootValue,
      contextValue,
      variableValues,
      operationName,
      subscribeFieldResolver
    );
  } catch (error) {
    // GraphQLError represent "field" or "query" errors, to be returned to
    // the requesting client. Other errors are "internal" errors, which
    // reject the stream.
    return error instanceof GraphQLError ?
      asyncIteratorResolve({ errors: [ error ] }) :
      asyncIteratorReject(error);
  }

  // For each payload yielded from a subscription, map it over the normal
  // GraphQL `execute` function, with `payload` as the rootValue.
  // This implements the "MapSourceToResponseEvent" algorithm described in
  // the GraphQL specification. The `execute` function provides the
  // "ExecuteSubscriptionEvent" algorithm, as it is nearly identical to the
  // "ExecuteQuery" algorithm, for which `execute` is also used.
  return mapAsyncIterator(
    subscription,
    payload => execute(
      schema,
      document,
      payload,
      contextValue,
      variableValues,
      operationName,
      fieldResolver
    )
  );
}

/**
 * Implements the "CreateSourceEventStream" algorithm described in the
 * GraphQL specification, resolving the subscription source event stream.
 *
 * Returns an AsyncIterable.
 * If an error is encountered during creation, an Error is thrown.
 *
 * A Source Stream represents the sequence of events, each of which is
 * expected to be used to trigger a GraphQL execution for that event.
 *
 * This may be useful when hosting the stateful subscription service in a
 * different process or machine than the stateless GraphQL execution engine,
 * or otherwise separating these two steps. For more on this, see the
 * "Supporting Subscriptions at Scale" information in the GraphQL specification.
 */
export function createSourceEventStream(
  schema: GraphQLSchema,
  document: DocumentNode,
  rootValue?: mixed,
  contextValue?: mixed,
  variableValues?: ?{[key: string]: mixed},
  operationName?: ?string,
  fieldResolver?: ?GraphQLFieldResolver<any, any>
): AsyncIterable<mixed> {
  // If arguments are missing or incorrect, throw an error.
  assertValidExecutionArguments(
    schema,
    document,
    variableValues
  );

  // If a valid context cannot be created due to incorrect arguments,
  // this will throw an error.
  const exeContext = buildExecutionContext(
    schema,
    document,
    rootValue,
    contextValue,
    variableValues,
    operationName,
    fieldResolver
  );

  const type = getOperationRootType(schema, exeContext.operation);
  const fields = collectFields(
    exeContext,
    type,
    exeContext.operation.selectionSet,
    Object.create(null),
    Object.create(null)
  );
  const responseNames = Object.keys(fields);
  const responseName = responseNames[0];
  const fieldNodes = fields[responseName];
  const fieldNode = fieldNodes[0];
  const fieldDef = getFieldDef(schema, type, fieldNode.name.value);
  if (!fieldDef) {
    return emptyAsyncIterator();
  }

  // Call the `subscribe()` resolver or the default resolver to produce an
  // AsyncIterable yielding raw payloads.
  const resolveFn = fieldDef.subscribe || exeContext.fieldResolver;

  const path = addPath(undefined, responseName);

  const info = buildResolveInfo(
    exeContext,
    fieldDef,
    fieldNodes,
    type,
    path
  );

  // resolveFieldValueOrError implements the "ResolveFieldEventStream"
  // algorithm from GraphQL specification. It differs from
  // "ResolveFieldValue" due to providing a different `resolveFn`.
  const subscription = resolveFieldValueOrError(
    exeContext,
    fieldDef,
    fieldNodes,
    resolveFn,
    rootValue,
    info
  );

  // Throw located GraphQLError if subscription source fails to resolve.
  if (subscription instanceof Error) {
    throw locatedError(subscription, fieldNodes, responsePathAsArray(path));
  }

  if (!isAsyncIterable(subscription)) {
    throw new Error(
      'Subscription must return Async Iterable. Returned: ' +
        String(subscription)
    );
  }

  return (subscription: any);
}
