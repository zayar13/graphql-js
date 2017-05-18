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

import { $$asyncIterator } from 'iterall';

/**
 * Given a value, returns an AsyncIterable which will yield once with
 * that value.
 *
 * Similar to Promise.resolve(error)
 */
export default function asyncIteratorResolve<T>(value: T): AsyncIterator<T> {
  let isComplete = false;
  return {
    next() {
      const result = isComplete ?
        Promise.resolve({ value: undefined, done: true }) :
        Promise.resolve({ value, done: false });
      isComplete = true;
      return result;
    },
    return() {
      isComplete = true;
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(error) {
      isComplete = true;
      return Promise.reject(error);
    },
    [$$asyncIterator]() {
      return this;
    },
  };
}
