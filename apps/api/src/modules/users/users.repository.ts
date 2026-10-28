import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../../db/schema.js'
import type { UserResponse } from './users.schema.js'

export class UsersRepository {
	constructor(private readonly db: NodePgDatabase<typeof schema>) {}

	async create(data: { name: string; email: string }): Promise<UserResponse | undefined> {
		const [user] = await this.db.insert(schema.users).values(data).returning({
			id: schema.users.id,
			name: schema.users.name,
			email: schema.users.email,
		})

		if (!user) {
			return undefined
		}

		return user
	}

	async findById(id: string): Promise<UserResponse | null> {
		const [user] = await this.db
			.select({
				id: schema.users.id,
				name: schema.users.name,
				email: schema.users.email,
			})
			.from(schema.users)
			.where(eq(schema.users.id, id))
			.limit(1)

		return user ?? null
	}
}
