import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError } from '../common/errors/app-error.js';
import { env } from '../config/env.js';

declare module 'fastify' {
    interface FastifyInstance {
        requireAuth: preHandlerHookHandler;
    }
    interface FastifyRequest {
        userId: string;
    }
}

const authPlugin: FastifyPluginAsync = async (app) => {
    // Neon Auth signs session JWTs; jose caches the keys and refetches on rotation
    const jwks = createRemoteJWKSet(new URL(`${env.NEON_AUTH_URL}/.well-known/jwks.json`));

    app.decorateRequest('userId', '');

    app.decorate('requireAuth', async (request) => {
        const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
        if (scheme !== 'Bearer' || !token) {
            throw new AppError('UNAUTHORIZED', 'Missing bearer token', 401);
        }

        try {
            const { payload } = await jwtVerify(token, jwks);
            if (!payload.sub) throw new Error('Token has no subject');
            request.userId = payload.sub;
        } catch {
            throw new AppError('UNAUTHORIZED', 'Invalid or expired token', 401);
        }
    });
};

export const registerAuth = fp(authPlugin, { name: 'auth' });
