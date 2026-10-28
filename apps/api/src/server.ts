import { buildServer } from './app.js'
import { env } from './config/env.js'

const app = await buildServer()

try {
	await app.listen({
		host: env.HOST,
		port: env.PORT,
	})
} catch (error) {
	app.log.error({ err: error }, 'Failed to start server')
	process.exit(1)
}

let shuttingDown = false

async function shutdown(signal: string) {
	if (shuttingDown) return
	shuttingDown = true

	app.log.info({ signal }, 'Shutting down')

	try {
		await app.close()
		process.exitCode = 0
	} catch (error) {
		app.log.error({ err: error }, 'Shutdown failed')
		process.exitCode = 1
	}
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
