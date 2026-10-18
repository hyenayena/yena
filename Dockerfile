FROM node:24-alpine
# git (+ ssh for git@ URLs) is used by `mod install` to download modules
RUN apk add --no-cache git openssh-client bash ripgrep
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
CMD ["npm", "run", "dev"]
