set DATABASE_URL=postgresql://ensemb:ensemb_dev@localhost:5433/ensemb
set REDIS_URL=redis://localhost:6380
set PORT=3000
set NODE_ENV=development
set APP_ENCRYPTION_KEY=dev_encryption_key_32chars_minimum
set JWT_SECRET=dev_jwt_secret_key_for_local_use
set JWT_REFRESH_SECRET=dev_jwt_refresh_secret_for_local
set PLATFORM_JWT_SECRET=dev_platform_jwt_secret_local
cd /d C:\Users\Kevin\Desktop\Ensemb\apps\api
pnpm dev
