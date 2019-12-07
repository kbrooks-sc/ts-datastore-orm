// https://cloud.google.com/datastore/docs/concepts/transactions

import * as DataStore from "@google-cloud/datastore";
import {BaseEntity} from "./BaseEntity";
import {datastoreOrm} from "./datastoreOrm";
import {errorCodes} from "./enums/errorCodes";
import {PerformanceHelper} from "./helpers/PerformanceHelper";
import {Query} from "./Query";
import {IArgvId, IArgvTransactionOptions, IRequestResponse, ISaveResult, ITransactionResponse} from "./types";
// datastore transaction operations:
// insert: save if not exist
// update: save if exist
// save, upsert: save not matter exist or not
// merge: merge partial keys, has bugs
// above should not use await (it probably will be done by batch by transaction)

const timeout = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const defaultValues = {delay: 50};

export class Transaction {
    public static async execute<T extends any>(callback: (transaction: Transaction) => Promise<T>,
                                               options: IArgvTransactionOptions = {}): Promise<[T, ITransactionResponse]> {
        // return result
        let result: any;
        const transactionResponse: ITransactionResponse = {
            isSuccess: false,
            totalRetry: 0,
            executionTime: 0,
            savedEntities: [],
            deletedEntities: [],
        };
        const performanceHelper = new PerformanceHelper().start();
        const friendlyErrorStack = datastoreOrm.useFriendlyErrorStack();
        const delay = options.delay || defaultValues.delay;
        const maxRetry = Math.max(1, options.maxRetry || 1);

        for (let i = 0; i < maxRetry; i++) {
            // start transaction
            const transaction = new Transaction(options);
            try {
                // init transaction
                await transaction.run();

                // run the callback
                result = await callback(transaction);

                // check if user has cancelled the commit
                if (!transaction.skipCommit) {
                    await transaction.commit();
                    transactionResponse.isSuccess = true;
                }

                transactionResponse.savedEntities = transaction.savedEntities;
                transactionResponse.deletedEntities = transaction.deletedEntities;

                // break out the retry loop
                break;

            } catch (err) {
                // we don't need to wait for rollback for better performance
                transaction.rollback();

                // retry transaction only if aborted
                if ((err as any).code === errorCodes.ABORTED) {
                    if (i < maxRetry - 1) {
                        transactionResponse.totalRetry += 1;
                        // add some retry factor
                        const totalDelay = delay * (i + 1);

                        // wait for a while
                        await timeout(totalDelay);
                        continue;
                    }
                }

                // we reached max retry or not able to retry, throw the error
                if (friendlyErrorStack) {
                    err.stack = friendlyErrorStack;
                }

                throw err;
            }
        }

        return [result, Object.assign(transactionResponse, performanceHelper.readResult())];
    }

    // datastore transaction
    public datastoreTransaction: DataStore.Transaction;

    // entities pending for save
    public savedEntities: BaseEntity[];
    public deletedEntities: BaseEntity[];

    // internal handling for rollback
    public skipCommit: boolean = false;

    constructor(options: Partial<IArgvTransactionOptions> = {}) {
        const datastore = datastoreOrm.getDatastore();
        this.datastoreTransaction = datastore.transaction({readOnly: options.readOnly});
        this.savedEntities = [];
        this.deletedEntities = [];
    }

    // region public methods

    // start transaction
    public run() {
        return this.datastoreTransaction.run();
    }

    public async commit(): Promise<[IRequestResponse]> {
        const performanceHelper = new PerformanceHelper().start();

        const [result] = await this.datastoreTransaction.commit();
        this._processCommitResult(result as ISaveResult);

        return [performanceHelper.readResult()];
    }

    public async rollback() {
        // clear it
        this.savedEntities = [];
        this.skipCommit = true;
        return this.datastoreTransaction.rollback();
    }

    public query<T extends typeof BaseEntity>(entityType: T) {
        const entityMeta = datastoreOrm.getEntityMeta(entityType);
        return new Query(entityType, this);
    }

    public async find<T extends typeof BaseEntity>(entityType: T, id: IArgvId): Promise<[InstanceType<T> | undefined, IRequestResponse]> {
        const [entities, queryResponse] = await this.findMany(entityType, [id]);
        return [entities.length ? entities[0] : undefined, queryResponse];
    }

    public async findMany<T extends typeof BaseEntity>(entityType: T, ids: IArgvId[]): Promise<[Array<InstanceType<T>>, IRequestResponse]> {
        const performanceHelper = new PerformanceHelper().start();

        // get the keys
        const keys = ids.map(x => datastoreOrm.createKey(entityType, x));
        const [results] = await this.datastoreTransaction.get(keys);

        // convert into entities
        let entities: any[] = [];
        if (Array.isArray(results)) {
            entities = results.map(x => entityType.newFromEntityData(x));
        }

        return [entities, performanceHelper.readResult()];
    }

    public save<T extends BaseEntity>(entity: T) {
        this.saveMany([entity]);
    }

    public saveMany<T extends BaseEntity>(entities: T[]) {
        const insertEntities = entities.filter(x => x.isNew);
        const updateEntities = entities.filter(x => !x.isNew);

        if (insertEntities.length) {
            // set isNew to false
            const insertSaveDataList = insertEntities.map(x => x.getSaveData());
            insertEntities.forEach(x => x.isNew = false);
            this.datastoreTransaction.insert(insertSaveDataList);
        }

        if (updateEntities.length) {
            const updateSaveDataList = updateEntities.map(x => x.getSaveData());
            this.datastoreTransaction.update(updateSaveDataList);
        }

        // append to saved entities
        this.savedEntities = this.savedEntities.concat(entities);
    }

    public delete<T extends BaseEntity>(entity: T) {
        this.deleteMany([entity]);
    }

    public deleteMany<T extends BaseEntity>(entities: T[]) {
        const keys = entities.map(x => x.getKey());
        this.datastoreTransaction.delete(keys);

        // append to deleted entities
        this.deletedEntities = this.deletedEntities.concat(entities);
    }

    public async allocateIds<T extends typeof BaseEntity>(entityType: T, total = 1): Promise<[number[], IRequestResponse]> {
        // this.datastoreTransaction.allocateIds();
        const performanceHelper = new PerformanceHelper().start();

        const datastore = datastoreOrm.getDatastore();
        const key = datastoreOrm.createKey(entityType);
        const [keys] =  await this.datastoreTransaction.allocateIds(key, {allocations: total});
        const ids = keys.map(x => Number(x.id));

        return [ids, performanceHelper.readResult()];
    }

    // endregion

    // region private methods

    private _processCommitResult(saveResult: ISaveResult) {
        if (this.savedEntities.length) {
            const newKeys = datastoreOrm.extractMutationKeys(saveResult);

            // update the key
            for (let i = 0; i < newKeys.length; i++) {
                const entity = this.savedEntities[i];
                const newKey = newKeys[i];
                if (!(entity as any)._id) {
                    (entity as any)._set("id", Number(newKey.id));
                }
            }
        }
    }

    // endregion
}