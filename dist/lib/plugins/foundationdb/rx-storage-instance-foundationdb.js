"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RxStorageInstanceFoundationDB = void 0;
exports.createFoundationDBStorageInstance = createFoundationDBStorageInstance;

var _rxjs = require("rxjs");

var _rxSchemaHelper = require("../../rx-schema-helper");

var _rxStorageHelper = require("../../rx-storage-helper");

var _foundationdbHelpers = require("./foundationdb-helpers");

var _rxError = require("../../rx-error");

var _customIndex = require("../../custom-index");

var _util = require("../../util");

var _foundationdbQuery = require("./foundationdb-query");

var _queryPlanner = require("../../query-planner");

var _memory = require("../memory");

// import {
//     open as foundationDBOpen,
//     directory as foundationDBDirectory,
//     encoders as foundationDBEncoders,
//     keySelector as foundationDBKeySelector,
//     StreamingMode as foundationDBStreamingMode
// } from 'foundationdb';
var RxStorageInstanceFoundationDB = /*#__PURE__*/function () {
  function RxStorageInstanceFoundationDB(storage, databaseName, collectionName, schema, internals, options, settings) {
    this.closed = false;
    this.changes$ = new _rxjs.Subject();
    this.storage = storage;
    this.databaseName = databaseName;
    this.collectionName = collectionName;
    this.schema = schema;
    this.internals = internals;
    this.options = options;
    this.settings = settings;
    this.primaryPath = (0, _rxSchemaHelper.getPrimaryFieldOfPrimaryKey)(this.schema.primaryKey);
  }

  var _proto = RxStorageInstanceFoundationDB.prototype;

  _proto.bulkWrite = function bulkWrite(documentWrites, context) {
    try {
      var _this2 = this;

      return Promise.resolve(_this2.internals.dbsPromise).then(function (dbs) {
        var categorized = null;
        return Promise.resolve(dbs.root.doTransaction(function (tx) {
          try {
            var ret = {
              success: {},
              error: {}
            };
            var ids = documentWrites.map(function (row) {
              return row.document[_this2.primaryPath];
            });
            var mainTx = tx.at(dbs.main.subspace);
            var attachmentTx = tx.at(dbs.attachments.subspace);
            var docsInDB = new Map();
            /**
             * TODO this might be faster if fdb
             * any time adds a bulk-fetch-by-key method.
             */

            return Promise.resolve(Promise.all(ids.map(function (id) {
              try {
                return Promise.resolve(mainTx.get(id)).then(function (doc) {
                  docsInDB.set(id, doc);
                });
              } catch (e) {
                return Promise.reject(e);
              }
            }))).then(function () {
              categorized = (0, _rxStorageHelper.categorizeBulkWriteRows)(_this2, _this2.primaryPath, docsInDB, documentWrites, context);
              categorized.errors.forEach(function (err) {
                ret.error[err.documentId] = err;
              }); // INSERTS

              categorized.bulkInsertDocs.forEach(function (writeRow) {
                var docId = writeRow.document[_this2.primaryPath];
                ret.success[docId] = writeRow.document; // insert document data

                mainTx.set(docId, writeRow.document); // insert secondary indexes

                Object.values(dbs.indexes).forEach(function (indexMeta) {
                  var indexString = indexMeta.getIndexableString(writeRow.document);
                  var indexTx = tx.at(indexMeta.db.subspace);
                  indexTx.set(indexString, docId);
                });
              }); // UPDATES

              categorized.bulkUpdateDocs.forEach(function (writeRow) {
                var docId = writeRow.document[_this2.primaryPath]; // overwrite document data

                mainTx.set(docId, writeRow.document); // update secondary indexes

                Object.values(dbs.indexes).forEach(function (indexMeta) {
                  var oldIndexString = indexMeta.getIndexableString((0, _util.ensureNotFalsy)(writeRow.previous));
                  var newIndexString = indexMeta.getIndexableString(writeRow.document);

                  if (oldIndexString !== newIndexString) {
                    var indexTx = tx.at(indexMeta.db.subspace);
                    indexTx["delete"](oldIndexString);
                    indexTx.set(newIndexString, docId);
                  }
                });
                ret.success[docId] = writeRow.document;
              }); // attachments

              categorized.attachmentsAdd.forEach(function (attachment) {
                attachmentTx.set((0, _memory.attachmentMapKey)(attachment.documentId, attachment.attachmentId), attachment.attachmentData);
              });
              categorized.attachmentsUpdate.forEach(function (attachment) {
                attachmentTx.set((0, _memory.attachmentMapKey)(attachment.documentId, attachment.attachmentId), attachment.attachmentData);
              });
              categorized.attachmentsRemove.forEach(function (attachment) {
                attachmentTx["delete"]((0, _memory.attachmentMapKey)(attachment.documentId, attachment.attachmentId));
              });
              return ret;
            });
          } catch (e) {
            return Promise.reject(e);
          }
        })).then(function (result) {
          /**
           * The events must be emitted AFTER the transaction
           * has finished.
           * Otherwise an observable changestream might cause a read
           * to a document that does not already exist outside of the transaction.
           */
          if ((0, _util.ensureNotFalsy)(categorized).eventBulk.events.length > 0) {
            var lastState = (0, _rxStorageHelper.getNewestOfDocumentStates)(_this2.primaryPath, Object.values(result.success));
            (0, _util.ensureNotFalsy)(categorized).eventBulk.checkpoint = {
              id: lastState[_this2.primaryPath],
              lwt: lastState._meta.lwt
            };

            _this2.changes$.next((0, _util.ensureNotFalsy)(categorized).eventBulk);
          }

          return result;
        });
      });
    } catch (e) {
      return Promise.reject(e);
    }
  };

  _proto.findDocumentsById = function findDocumentsById(ids, withDeleted) {
    try {
      var _this4 = this;

      return Promise.resolve(_this4.internals.dbsPromise).then(function (dbs) {
        return dbs.main.doTransaction(function (tx) {
          try {
            var ret = {};
            return Promise.resolve(Promise.all(ids.map(function (docId) {
              try {
                return Promise.resolve(tx.get(docId)).then(function (docInDb) {
                  if (docInDb && (!docInDb._deleted || withDeleted)) {
                    ret[docId] = docInDb;
                  }
                });
              } catch (e) {
                return Promise.reject(e);
              }
            }))).then(function () {
              return ret;
            });
          } catch (e) {
            return Promise.reject(e);
          }
        });
      });
    } catch (e) {
      return Promise.reject(e);
    }
  };

  _proto.query = function query(preparedQuery) {
    return (0, _foundationdbQuery.queryFoundationDB)(this, preparedQuery);
  };

  _proto.getAttachmentData = function getAttachmentData(documentId, attachmentId) {
    try {
      var _this6 = this;

      return Promise.resolve(_this6.internals.dbsPromise).then(function (dbs) {
        return Promise.resolve(dbs.attachments.get((0, _memory.attachmentMapKey)(documentId, attachmentId))).then(function (attachment) {
          return attachment.data;
        });
      });
    } catch (e) {
      return Promise.reject(e);
    }
  };

  _proto.getChangedDocumentsSince = function getChangedDocumentsSince(limit, checkpoint) {
    try {
      var _this8 = this;

      var _require = require('foundationdb'),
          keySelector = _require.keySelector,
          StreamingMode = _require.StreamingMode;

      return Promise.resolve(_this8.internals.dbsPromise).then(function (dbs) {
        var index = ['_meta.lwt', _this8.primaryPath];
        var indexName = (0, _foundationdbHelpers.getFoundationDBIndexName)(index);
        var indexMeta = dbs.indexes[indexName];
        var lowerBoundString = '';

        if (checkpoint) {
          var _checkpointPartialDoc;

          var checkpointPartialDoc = (_checkpointPartialDoc = {}, _checkpointPartialDoc[_this8.primaryPath] = checkpoint.id, _checkpointPartialDoc._meta = {
            lwt: checkpoint.lwt
          }, _checkpointPartialDoc);
          lowerBoundString = indexMeta.getIndexableString(checkpointPartialDoc);
        }

        return Promise.resolve(dbs.root.doTransaction(function (tx) {
          try {
            var innerResult = [];
            var indexTx = tx.at(indexMeta.db.subspace);
            var mainTx = tx.at(dbs.main.subspace);
            return Promise.resolve(indexTx.getRangeAll(keySelector.firstGreaterThan(lowerBoundString), _queryPlanner.INDEX_MAX, {
              limit: limit,
              streamingMode: StreamingMode.Exact
            })).then(function (range) {
              var docIds = range.map(function (row) {
                return row[1];
              });
              return Promise.resolve(Promise.all(docIds.map(function (docId) {
                return mainTx.get(docId);
              }))).then(function (docsData) {
                innerResult = innerResult.concat(docsData);
                return innerResult;
              });
            });
          } catch (e) {
            return Promise.reject(e);
          }
        })).then(function (result) {
          var lastDoc = (0, _util.lastOfArray)(result);
          return {
            documents: result,
            checkpoint: lastDoc ? {
              id: lastDoc[_this8.primaryPath],
              lwt: lastDoc._meta.lwt
            } : checkpoint ? checkpoint : {
              id: '',
              lwt: 0
            }
          };
        });
      });
    } catch (e) {
      return Promise.reject(e);
    }
  };

  _proto.changeStream = function changeStream() {
    return this.changes$.asObservable();
  };

  _proto.remove = function remove() {
    try {
      var _this10 = this;

      return Promise.resolve(_this10.internals.dbsPromise).then(function (dbs) {
        return Promise.resolve(dbs.root.doTransaction(function (tx) {
          tx.clearRange('', _queryPlanner.INDEX_MAX);
          return _util.PROMISE_RESOLVE_VOID;
        })).then(function () {
          return _this10.close();
        });
      });
    } catch (e) {
      return Promise.reject(e);
    }
  };

  _proto.cleanup = function cleanup(minimumDeletedTime) {
    try {
      var _this12 = this;

      var _require2 = require('foundationdb'),
          keySelector = _require2.keySelector,
          StreamingMode = _require2.StreamingMode;

      var maxDeletionTime = (0, _util.now)() - minimumDeletedTime;
      return Promise.resolve(_this12.internals.dbsPromise).then(function (dbs) {
        var index = _foundationdbHelpers.CLEANUP_INDEX;
        var indexName = (0, _foundationdbHelpers.getFoundationDBIndexName)(index);
        var indexMeta = dbs.indexes[indexName];
        var lowerBoundString = (0, _customIndex.getStartIndexStringFromLowerBound)(_this12.schema, index, [true,
        /**
         * Do not use 0 here,
         * because 1 is the minimum value for _meta.lwt
         */
        1]);
        var upperBoundString = (0, _customIndex.getStartIndexStringFromUpperBound)(_this12.schema, index, [true, maxDeletionTime]);
        var noMoreUndeleted = true;
        return Promise.resolve(dbs.root.doTransaction(function (tx) {
          try {
            var batchSize = (0, _util.ensureNotFalsy)(_this12.settings.batchSize);
            var indexTx = tx.at(indexMeta.db.subspace);
            var mainTx = tx.at(dbs.main.subspace);
            return Promise.resolve(indexTx.getRangeAll(keySelector.firstGreaterThan(lowerBoundString), upperBoundString, {
              limit: batchSize + 1,
              // get one more extra to detect what to return from cleanup()
              streamingMode: StreamingMode.Exact
            })).then(function (range) {
              if (range.length > batchSize) {
                noMoreUndeleted = false;
                range.pop();
              }

              var docIds = range.map(function (row) {
                return row[1];
              });
              return Promise.resolve(Promise.all(docIds.map(function (docId) {
                return mainTx.get(docId);
              }))).then(function (docsData) {
                Object.values(dbs.indexes).forEach(function (indexMeta) {
                  var subIndexDB = tx.at(indexMeta.db.subspace);
                  docsData.forEach(function (docData) {
                    var indexString = indexMeta.getIndexableString(docData);
                    subIndexDB["delete"](indexString);
                  });
                });
                docIds.forEach(function (id) {
                  return mainTx["delete"](id);
                });
              });
            });
          } catch (e) {
            return Promise.reject(e);
          }
        })).then(function () {
          return noMoreUndeleted;
        });
      });
    } catch (e) {
      return Promise.reject(e);
    }
  };

  _proto.conflictResultionTasks = function conflictResultionTasks() {
    return new _rxjs.Subject().asObservable();
  };

  _proto.resolveConflictResultionTask = function resolveConflictResultionTask(_taskSolution) {
    return _util.PROMISE_RESOLVE_VOID;
  };

  _proto.close = function close() {
    try {
      var _this14 = this;

      if (_this14.closed) {
        return Promise.reject((0, _rxError.newRxError)('SNH', {
          database: _this14.databaseName,
          collection: _this14.collectionName
        }));
      }

      _this14.closed = true;

      _this14.changes$.complete();

      return Promise.resolve(_this14.internals.dbsPromise).then(function (dbs) {
        dbs.root.close(); // TODO shouldnt we close the index databases?
        // Object.values(dbs.indexes).forEach(db => db.close());
      });
    } catch (e) {
      return Promise.reject(e);
    }
  };

  return RxStorageInstanceFoundationDB;
}();

exports.RxStorageInstanceFoundationDB = RxStorageInstanceFoundationDB;

function createFoundationDBStorageInstance(storage, params, settings) {
  var primaryPath = (0, _rxSchemaHelper.getPrimaryFieldOfPrimaryKey)(params.schema.primaryKey);

  var _require3 = require('foundationdb'),
      open = _require3.open,
      directory = _require3.directory,
      encoders = _require3.encoders;

  var connection = open(settings.clusterFile);

  var dbsPromise = function () {
    try {
      return Promise.resolve(directory.createOrOpen(connection, 'rxdb')).then(function (dir) {
        var root = connection.at(dir).at(params.databaseName + '.').at(params.collectionName + '.').at(params.schema.version + '.');
        var main = root.at('main.').withKeyEncoding(encoders.string) // automatically encode & decode keys using tuples
        .withValueEncoding(encoders.json); // and values using JSON

        var events = root.at('events.').withKeyEncoding(encoders.string).withValueEncoding(encoders.json);
        var attachments = root.at('attachments.').withKeyEncoding(encoders.string).withValueEncoding(encoders.json);
        var indexDBs = {};
        var useIndexes = params.schema.indexes ? params.schema.indexes.slice(0) : [];
        useIndexes.push([primaryPath]);
        var useIndexesFinal = useIndexes.map(function (index) {
          var indexAr = Array.isArray(index) ? index.slice(0) : [index];
          indexAr.unshift('_deleted');
          return indexAr;
        }); // used for `getChangedDocumentsSince()`

        useIndexesFinal.push(['_meta.lwt', primaryPath]);
        useIndexesFinal.push(_foundationdbHelpers.CLEANUP_INDEX);
        useIndexesFinal.forEach(function (indexAr) {
          var indexName = (0, _foundationdbHelpers.getFoundationDBIndexName)(indexAr);
          var indexDB = root.at(indexName + '.').withKeyEncoding(encoders.string).withValueEncoding(encoders.string);
          indexDBs[indexName] = {
            indexName: indexName,
            db: indexDB,
            getIndexableString: (0, _customIndex.getIndexableStringMonad)(params.schema, indexAr),
            index: indexAr
          };
        });
        return {
          root: root,
          main: main,
          events: events,
          attachments: attachments,
          indexes: indexDBs
        };
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }();

  var internals = {
    connection: connection,
    dbsPromise: dbsPromise
  };
  var instance = new RxStorageInstanceFoundationDB(storage, params.databaseName, params.collectionName, params.schema, internals, params.options, settings);
  return Promise.resolve(instance);
}
//# sourceMappingURL=rx-storage-instance-foundationdb.js.map