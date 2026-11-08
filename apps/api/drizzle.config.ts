import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

declare const process: { env: { DATABASE_URL?: string } };

export default defineConfig({
    dialect: 'postgresql',
    schema: './src/db/schema.ts',
    out: './drizzle',
    dbCredentials: {
        url: process.env.DATABASE_URL!,
    },
});
