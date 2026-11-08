import { eq } from 'drizzle-orm';
import { userInNeonAuth as users } from '../../db/auth-schema.js';
import type { Database } from '../../plugins/database.js';
import type { UserResponse } from './users.schema.js';

export class UsersRepository {
    constructor(private readonly db: Database) {}

    async findById(id: string): Promise<UserResponse | null> {
        const [user] = await this.db
            .select({
                id: users.id,
                name: users.name,
                email: users.email,
            })
            .from(users)
            .where(eq(users.id, id))
            .limit(1);

        return user ?? null;
    }
}
