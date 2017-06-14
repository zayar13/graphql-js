/**
 *  Copyright (c) 2015, Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree. An additional grant
 *  of patent rights can be found in the PATENTS file in the same directory.
 */

import { expect } from 'chai';
import { describe, it } from 'mocha';
import EventEmitter from 'events';
import eventEmitterAsyncIterator from './eventEmitterAsyncIterator';
import { subscribe } from '../subscribe';
import { parse } from '../../language';
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLList,
  GraphQLBoolean,
  GraphQLInt,
  GraphQLString,
} from '../../type';


describe('Subscribe', () => {

  const EmailType = new GraphQLObjectType({
    name: 'Email',
    fields: {
      from: { type: GraphQLString },
      subject: { type: GraphQLString },
      message: { type: GraphQLString },
      unread: { type: GraphQLBoolean },
    }
  });

  const InboxType = new GraphQLObjectType({
    name: 'Inbox',
    fields: {
      total: {
        type: GraphQLInt,
        resolve: inbox => inbox.emails.length,
      },
      unread: {
        type: GraphQLInt,
        resolve: inbox => inbox.emails.filter(email => email.unread).length,
      },
      emails: { type: new GraphQLList(EmailType) },
    }
  });

  const QueryType = new GraphQLObjectType({
    name: 'Query',
    fields: {
      inbox: { type: InboxType },
    }
  });

  const EmailEventType = new GraphQLObjectType({
    name: 'EmailEvent',
    fields: {
      email: { type: EmailType },
      inbox: { type: InboxType },
    }
  });

  const SubscriptionType = new GraphQLObjectType({
    name: 'Subscription',
    fields: {
      importantEmail: { type: EmailEventType },
    }
  });

  const emailSchema = new GraphQLSchema({
    query: QueryType,
    subscription: SubscriptionType
  });

  async function createSubscription(pubsub, schema = emailSchema) {
    const data = {
      inbox: {
        emails: [
          {
            from: 'joe@graphql.org',
            subject: 'Hello',
            message: 'Hello World',
            unread: false,
          },
        ],
      },
      importantEmail() {
        return eventEmitterAsyncIterator(pubsub, 'importantEmail');
      }
    };

    function sendImportantEmail(newEmail) {
      data.inbox.emails.push(newEmail);
      // Returns true if the event was consumed by a subscriber.
      return pubsub.emit('importantEmail', {
        importantEmail: {
          email: newEmail,
          inbox: data.inbox,
        }
      });
    }

    const ast = parse(`
      subscription ($priority: Int = 0) {
        importantEmail(priority: $priority) {
          email {
            from
            subject
          }
          inbox {
            unread
            total
          }
        }
      }
    `);

    // GraphQL `subscribe` has the same call signature as `execute`, but returns
    // Promise<AsyncIterator<ExecutionResult>>.
    return {
      sendImportantEmail,
      subscription: await subscribe(
        schema,
        ast,
        data
      ),
    };
  }

  it('accepts an object with named properties as arguments', async () => {
    const document = parse(`
      subscription {
        importantEmail
      }
    `);

    async function* emptyAsyncIterator() {
      // Empty
    }

    const ai = await subscribe({
      schema: emailSchema,
      document,
      rootValue: {
        importantEmail: emptyAsyncIterator
      }
    });

    ai.return();
  });

  async function expectPromiseToThrow(promise, message) {
    // TODO: replace with chai-as-promised
    let caughtError = undefined;
    try {
      await promise;
    } catch (e) {
      caughtError = e;
    }
    expect(caughtError.message).to.equal(message);
  }

  it('throws when missing schema', async () => {
    const document = parse(`
      subscription {
        importantEmail
      }
    `);

    await expectPromiseToThrow(
      subscribe(null, document),
      'Must provide schema'
    );

    await expectPromiseToThrow(
      subscribe({ document }),
      'Must provide schema'
    );
  });

  it('throws when missing document', async () => {
    await expectPromiseToThrow(
      subscribe(emailSchema, null),
      'Must provide document'
    );

    await expectPromiseToThrow(
      subscribe({ schema: emailSchema }),
      'Must provide document'
    );
  });

  it('multiple subscription fields defined in schema', async () => {
    const pubsub = new EventEmitter();
    const SubscriptionTypeMultiple = new GraphQLObjectType({
      name: 'Subscription',
      fields: {
        importantEmail: { type: EmailEventType },
        nonImportantEmail: { type: EmailEventType },
      }
    });

    const testSchema = new GraphQLSchema({
      query: QueryType,
      subscription: SubscriptionTypeMultiple
    });

    const { sendImportantEmail } = await createSubscription(pubsub, testSchema);

    sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Alright',
      message: 'Tests are good',
      unread: true,
    });
  });

  it('should only resolve the first field of invalid multi-field', async () => {
    let didResolveImportantEmail = false;
    let didResolveNonImportantEmail = false;

    const SubscriptionTypeMultiple = new GraphQLObjectType({
      name: 'Subscription',
      fields: {
        importantEmail: {
          type: EmailEventType,
          subscribe() {
            didResolveImportantEmail = true;
            return eventEmitterAsyncIterator(new EventEmitter(), 'event');
          }
        },
        nonImportantEmail: {
          type: EmailEventType,
          subscribe() {
            didResolveNonImportantEmail = true;
            return eventEmitterAsyncIterator(new EventEmitter(), 'event');
          }
        },
      }
    });

    const testSchema = new GraphQLSchema({
      query: QueryType,
      subscription: SubscriptionTypeMultiple
    });

    const ast = parse(`
      subscription {
        importantEmail
        nonImportantEmail
      }
    `);

    const subscription = await subscribe(testSchema, ast);
    subscription.next(); // Ask for a result, but ignore it.

    expect(didResolveImportantEmail).to.equal(true);
    expect(didResolveNonImportantEmail).to.equal(false);

    // Close subscription
    subscription.return();
  });

  it('produces payload for multiple subscribe in same subscription',
    async () => {
      const pubsub = new EventEmitter();
      const {
        sendImportantEmail,
        subscription,
      } = await createSubscription(pubsub);
      const second = await createSubscription(pubsub);

      const payload1 = subscription.next();
      const payload2 = second.subscription.next();

      expect(sendImportantEmail({
        from: 'yuzhi@graphql.org',
        subject: 'Alright',
        message: 'Tests are good',
        unread: true,
      })).to.equal(true);

      const expectedPayload = {
        done: false,
        value: {
          data: {
            importantEmail: {
              email: {
                from: 'yuzhi@graphql.org',
                subject: 'Alright',
              },
              inbox: {
                unread: 1,
                total: 2,
              },
            },
          },
        },
      };

      expect(await payload1).to.deep.equal(expectedPayload);
      expect(await payload2).to.deep.equal(expectedPayload);
    });

  it('produces a payload per subscription event', async () => {
    const pubsub = new EventEmitter();
    const {
      sendImportantEmail,
      subscription,
    } = await createSubscription(pubsub);

    // Wait for the next subscription payload.
    const payload = subscription.next();

    // A new email arrives!
    expect(sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Alright',
      message: 'Tests are good',
      unread: true,
    })).to.equal(true);

    // The previously waited on payload now has a value.
    expect(await payload).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              from: 'yuzhi@graphql.org',
              subject: 'Alright',
            },
            inbox: {
              unread: 1,
              total: 2,
            },
          },
        },
      },
    });

    // Another new email arrives, before subscription.next() is called.
    expect(sendImportantEmail({
      from: 'hyo@graphql.org',
      subject: 'Tools',
      message: 'I <3 making things',
      unread: true,
    })).to.equal(true);

    // The next waited on payload will have a value.
    expect(await subscription.next()).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              from: 'hyo@graphql.org',
              subject: 'Tools',
            },
            inbox: {
              unread: 2,
              total: 3,
            },
          },
        },
      },
    });

    // The client decides to disconnect.
    expect(await subscription.return()).to.deep.equal({
      done: true,
      value: undefined,
    });

    // Which may result in disconnecting upstream services as well.
    expect(sendImportantEmail({
      from: 'adam@graphql.org',
      subject: 'Important',
      message: 'Read me please',
      unread: true,
    })).to.equal(false); // No more listeners.

    // Awaiting a subscription after closing it results in completed results.
    expect(await subscription.next()).to.deep.equal({
      done: true,
      value: undefined,
    });
  });

  it('produces a payload when there are multiple events', async () => {
    const pubsub = new EventEmitter();
    const {
      sendImportantEmail,
      subscription,
    } = await createSubscription(pubsub);
    let payload = subscription.next();

    // A new email arrives!
    expect(sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Alright',
      message: 'Tests are good',
      unread: true,
    })).to.equal(true);

    expect(await payload).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              from: 'yuzhi@graphql.org',
              subject: 'Alright',
            },
            inbox: {
              unread: 1,
              total: 2,
            },
          },
        },
      },
    });

    payload = subscription.next();

    // A new email arrives!
    expect(sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Alright 2',
      message: 'Tests are good 2',
      unread: true,
    })).to.equal(true);

    expect(await payload).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              from: 'yuzhi@graphql.org',
              subject: 'Alright 2',
            },
            inbox: {
              unread: 2,
              total: 3,
            },
          },
        },
      },
    });
  });

  it('should not trigger when subscription is already done', async () => {
    const pubsub = new EventEmitter();
    const {
      sendImportantEmail,
      subscription,
    } = await createSubscription(pubsub);
    let payload = subscription.next();

    // A new email arrives!
    expect(sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Alright',
      message: 'Tests are good',
      unread: true,
    })).to.equal(true);

    expect(await payload).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              from: 'yuzhi@graphql.org',
              subject: 'Alright',
            },
            inbox: {
              unread: 1,
              total: 2,
            },
          },
        },
      },
    });

    payload = subscription.next();
    subscription.return();

    // A new email arrives!
    expect(sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Alright 2',
      message: 'Tests are good 2',
      unread: true,
    })).to.equal(false);

    expect(await payload).to.deep.equal({
      done: true,
      value: undefined,
    });
  });

  it('events order is correct when multiple triggered together', async () => {
    const pubsub = new EventEmitter();
    const {
      sendImportantEmail,
      subscription,
    } = await createSubscription(pubsub);
    let payload = subscription.next();

    // A new email arrives!
    expect(sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Message',
      message: 'Tests are good',
      unread: true,
    })).to.equal(true);

    // A new email arrives!
    expect(sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Message 2',
      message: 'Tests are good 2',
      unread: true,
    })).to.equal(true);

    expect(await payload).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              from: 'yuzhi@graphql.org',
              subject: 'Message',
            },
            inbox: {
              unread: 2,
              total: 3,
            },
          },
        },
      },
    });

    payload = subscription.next();

    expect(await payload).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              from: 'yuzhi@graphql.org',
              subject: 'Message 2',
            },
            inbox: {
              unread: 2,
              total: 3,
            },
          },
        },
      },
    });
  });

  it('invalid query should result in error', async () => {
    const invalidAST = parse(`
      subscription {
        invalidField
      }
    `);

    expectPromiseToThrow(
      subscribe(
        emailSchema,
        invalidAST,
      ),
      'This subscription is not defined by the schema.'
    );
  });

  it('throws when subscription definition doesnt return iterator', () => {
    const invalidEmailSchema = new GraphQLSchema({
      query: QueryType,
      subscription: new GraphQLObjectType({
        name: 'Subscription',
        fields: {
          importantEmail: {
            type: GraphQLString,
            subscribe: () => 'test',
          },
        }
      })
    });

    const ast = parse(`
      subscription {
        importantEmail
      }
    `);

    expectPromiseToThrow(
      subscribe(
        invalidEmailSchema,
        ast
      ),
      'Subscription must return Async Iterable. Received: test'
    );
  });

  it('expects to have subscribe on type definition with iterator', async () => {
    const pubsub = new EventEmitter();
    const emailSchema = new GraphQLSchema({
      query: QueryType,
      subscription: new GraphQLObjectType({
        name: 'Subscription',
        fields: {
          importantEmail: {
            type: GraphQLString,
            subscribe: () => eventEmitterAsyncIterator(pubsub, 'importantEmail')
          },
        }
      })
    });

    const ast = parse(`
      subscription {
        importantEmail
      }
    `);

    await subscribe(
      emailSchema,
      ast
    );
  });

  it('should handle error thrown by subscribe method', () => {
    const emailSchema = new GraphQLSchema({
      query: QueryType,
      subscription: new GraphQLObjectType({
        name: 'Subscription',
        fields: {
          importantEmail: {
            type: GraphQLString,
            subscribe: () => {
              throw new Error('test error');
            },
          },
        },
      })
    });

    const ast = parse(`
      subscription {
        importantEmail
      }
    `);

    expectPromiseToThrow(
      subscribe(
        emailSchema,
        ast
      ),
      'test error'
    );
  });

  it('expects subscribe to return a promise', async () => {
    const pubsub = new EventEmitter();
    const emailSchema = new GraphQLSchema({
      query: QueryType,
      subscription: new GraphQLObjectType({
        name: 'Subscription',
        fields: {
          importantEmail: {
            type: GraphQLString,
            subscribe: async () => {
              await new Promise(setImmediate);
              return eventEmitterAsyncIterator(pubsub, 'importantEmail');
            }
          },
        }
      })
    });

    const ast = parse(`
      subscription {
        importantEmail
      }
    `);

    const result = subscribe(
      emailSchema,
      ast
    );

    // make sure we got a promise
    expect(result.then).to.not.equal(undefined);
  });
});
