import { Type, type Static } from '@sinclair/typebox';

export const UserIdParamsSchema = Type.Object({
    id: Type.String({ format: 'uuid' }),
});

export const UserResponseSchema = Type.Object({
    id: Type.String(),
    name: Type.String(),
    email: Type.String({ format: 'email' }),
});

export const ErrorResponseSchema = Type.Object({
    error: Type.Object({
        code: Type.String(),
        message: Type.String(),
    }),
});

export type UserIdParams = Static<typeof UserIdParamsSchema>;
export type UserResponse = Static<typeof UserResponseSchema>;
