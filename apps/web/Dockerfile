# Image de production — artefacts buildés localement (pnpm turbo build)
# Le build Vite se fait sur la machine hôte ; Docker ne télécharge aucun package.
FROM nginx:1.27-alpine AS runner

COPY apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
