FROM node:18.18.2-alpine3.18 AS withdeps

ARG NODE_ENV

# set $HOME so yarn commands don't complain about not finding a config file:
#    Error: ENOTDIR: not a directory, open '/dev/null/.config/yarn'
ENV NODE_ENV=${NODE_ENV:-production} \
    HOME=/tmp
WORKDIR /app
ADD package.json yarn.lock ./
RUN yarn install \
      && yarn cache clean

FROM withdeps
EXPOSE 3000
# the 'guest' user is built in to Alpine
USER guest
ADD --chown=guest:users . ./
#
CMD [ "yarn", "start:prod" ]
