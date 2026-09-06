#!/bin/bash
# TMO production launcher (sandbox) — unset DATABASE_URL shell để .env
# file:../db/custom.db (tương đối) được Prisma resolve đúng như pm2 cũ.
unset DATABASE_URL
cd /home/z/tmo-app
exec bun run dev
