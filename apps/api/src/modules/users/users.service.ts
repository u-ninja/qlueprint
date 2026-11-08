import { AppError } from '../../common/errors/app-error.js';
import type { UsersRepository } from './users.repository.js';

export class UsersService {
    constructor(private readonly usersRepository: UsersRepository) {}

    async getUserById(id: string) {
        const user = await this.usersRepository.findById(id);

        if (!user) {
            throw new AppError('USER_NOT_FOUND', 'User not found', 404);
        }

        return user;
    }
}
