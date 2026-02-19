FROM node:20-alpine

WORKDIR /app

RUN apk add --update go~=1.25

ARG BUILD_FROM_SOURCE

COPY package*.json tsconfig*.json .mocharc.js ./
COPY lib/ ./lib
COPY test/ ./test
COPY scripts/ ./scripts

RUN npm i

CMD ["npm", "run", "test:integration"]
