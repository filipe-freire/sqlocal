import { v4 as uuidv4 } from 'uuid';
import type {
	ConfigMessage,
	DataMessage,
	ErrorMessage,
	Message,
	QueryKey,
	QueryMessage,
	Sqlite3Method,
	TransactionMessage,
} from './types';

export class SQLocal {
	worker: Worker;
	database: string;
	queriesInProgress = new Map<
		QueryKey,
		[resolve: (message: DataMessage) => void, reject: (message: ErrorMessage) => void]
	>();

	constructor(database: string) {
		this.worker = new Worker(new URL('./worker', import.meta.url), { type: 'module' });

		this.database = database;
		this.worker.postMessage({
			type: 'config',
			key: 'database',
			value: database,
		} as ConfigMessage);

		this.worker.addEventListener('message', ({ data: message }: { data: Message }) => {
			switch (message.type) {
				case 'data':
				case 'error':
					if (message.queryKey && this.queriesInProgress.has(message.queryKey)) {
						const [resolve, reject] = this.queriesInProgress.get(message.queryKey)!;
						if (message.type === 'error') {
							reject(message);
						} else {
							resolve(message);
						}
						this.queriesInProgress.delete(message.queryKey);
					} else if (message.type === 'error') {
						console.error(message.error);
					}
					break;
			}
		});
	}

	private createQuery = () => {
		const queryKey = uuidv4();
		return {
			key: queryKey,
			data: new Promise<DataMessage>((resolve, reject) => {
				this.queriesInProgress.set(queryKey, [resolve, reject]);
			}),
		};
	};

	private convertSqlTemplate = (queryTemplate: TemplateStringsArray, ...params: any[]) => {
		return {
			sql: queryTemplate.join('?'),
			params,
		};
	};

	sql = async (queryTemplate: TemplateStringsArray, ...params: any[]) => {
		const statement = this.convertSqlTemplate(queryTemplate, ...params);
		const { rows, columns } = await this.driver(statement.sql, statement.params, 'all');

		return rows.map((row) => {
			const rowObj: Record<string, any> = {};
			columns.forEach((column, columnIndex) => {
				rowObj[column] = row[columnIndex];
			});
			return rowObj;
		});
	};

	driver = async (sql: string, params: any[], method: Sqlite3Method) => {
		const query = this.createQuery();

		this.worker.postMessage({
			type: 'query',
			queryKey: query.key,
			sql,
			params,
			method,
		} satisfies QueryMessage);

		const { rows, columns } = await query.data;
		return { rows, columns };
	};

	transaction = async (
		passStatements: (
			sql: SQLocal['convertSqlTemplate']
		) => ReturnType<SQLocal['convertSqlTemplate']>[]
	) => {
		const statements = passStatements(this.convertSqlTemplate);
		const query = this.createQuery();

		this.worker.postMessage({
			type: 'transaction',
			queryKey: query.key,
			statements,
		} satisfies TransactionMessage);

		await query.data;
	};

	getDatabaseFile = async () => {
		const opfs = await navigator.storage.getDirectory();
		const filehandle = await opfs.getFileHandle(this.database);
		return await filehandle.getFile();
	};
}
