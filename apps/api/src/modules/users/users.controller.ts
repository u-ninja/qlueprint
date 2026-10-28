import type { FastifyReply, FastifyRequest } from 'fastify'
import type { UserIdParams } from './users.schema.js'
import type { UsersService } from './users.service.js'

export class UsersController {
	constructor(private readonly usersService: UsersService) {}

	getUserById = async (request: FastifyRequest<{ Params: UserIdParams }>, reply: FastifyReply) => {
		const user = await this.usersService.getUserById(request.params.id)

		return reply.code(200).send(user)
	}
}
