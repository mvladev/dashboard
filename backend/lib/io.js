//
// Copyright (c) 2018 by SAP SE or an SAP affiliate company. All rights reserved. This file is licensed under the Apache Software License, v. 2 except as noted otherwise in the LICENSE file
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

'use strict'

const _ = require('lodash')
const socketIO = require('socket.io')
const socketIOAuth = require('socketio-auth')
const logger = require('./logger')
const { jwt } = require('./middleware')
const { projects, shoots, journals, administrators } = require('./services')
const { getIssueComments } = journals
const watches = require('./watches')
const { EventsEmitter, NamespacedBatchEmitter } = require('./utils/batchEmitter')
const { getJournalCache } = require('./cache')

const jwtIO = jwt({
  resultProperty: 'user',
  getToken (req) {
    return req.auth.bearer
  }
})

function socketAuthentication (nsp) {
  socketIOAuth(nsp, {
    timeout: 5000,
    authenticate (socket, data, cb) {
      logger.debug('Socket %s authenticating', socket.id)
      const bearer = data.bearer || data.token
      const auth = {bearer}
      const req = {auth}
      const res = {}
      const next = (err) => {
        const user = res.user
        if (user) {
          user.auth = auth
          user.id = user['email']
        } else {
          logger.error('Socket %s: no user on response object', socket.id)
        }
        if (err) {
          logger.error('Socket %s authentication failed: "%s"', socket.id, err.message)
          return cb(err)
        }
        logger.debug('Socket %s authenticated (user %s)', socket.id, user.id)
        socket.client.user = user

        cb(null, true)
      }
      jwtIO(req, res, next)
    }
  })
}

function onDisconnect (reason) {
  logger.debug('Socket %s disconnected. Reason: %s', this.id, reason)
}

function getUserFromSocket (socket) {
  const user = _.get(socket, 'client.user')
  if (!user) {
    logger.error('Could not get client.user from socket', socket.id)
  }
  return user
}

function joinRoom (socket, room) {
  socket.join(room)
  logger.debug('Socket %s subscribed to room "%s"', socket.id, room)
}

function leaveRooms (socket, predicate = _.identity) {
  _
    .chain(socket.rooms)
    .keys()
    .filter(predicate)
    .each(room => {
      logger.debug('Socket %s leaving room %s', socket.id, room)
      socket.leave(room)
    })
    .commit()
}

function leaveShootsAndShootRoom (socket) {
  const predicate = room => room !== socket.id
  leaveRooms(socket, predicate)
}

function leaveIssuesRoom (socket) {
  const predicate = room => room !== socket.id && !_.startsWith(room, 'comments_')
  leaveRooms(socket, predicate)
}

function leaveCommentsRooms (socket) {
  const predicate = room => room !== socket.id && room !== 'issues'
  leaveRooms(socket, predicate)
}

function setupShootsNamespace (shootsNsp) {
  const subscribeShoots = async function ({socket, namespacesAndFilters, projectList}) {
    leaveShootsAndShootRoom(socket)

    /* join current rooms */
    if (!_.isArray(namespacesAndFilters)) {
      return
    }
    const kind = 'shoots'
    const user = getUserFromSocket(socket)
    const batchEmitter = new NamespacedBatchEmitter({kind, socket, objectKeyPath: 'metadata.uid'})

    await _
      .chain(namespacesAndFilters)
      .filter(({namespace}) => !!_.find(projectList, ['metadata.namespace', namespace]))
      .map(async ({namespace, filter}) => {
        // join room
        const shootsWithIssuesOnly = !!filter
        const room = filter ? `shoots_${namespace}_${filter}` : `shoots_${namespace}`
        joinRoom(socket, room)
        try {
          // fetch shoots for namespace
          const shootList = await shoots.list({user, namespace, shootsWithIssuesOnly})
          batchEmitter.batchEmitObjects(shootList.items, namespace)
        } catch (error) {
          logger.error('Socket %s: failed to subscribe to shoots: %s', socket.id, error)
          socket.emit('subscription_error', {
            kind,
            code: 500,
            message: `Failed to fetch shoots for namespace ${namespace}`
          })
        }
      })
      .thru(promises => Promise.all(promises))
      .value()

    batchEmitter.flush()
    socket.emit('batchNamespacedEventsDone', {
      kind,
      namespaces: _.map(namespacesAndFilters, 'namespace')
    })
  }
  const subscribeShootsAdmin = async function ({socket, user, namespaces, filter}) {
    leaveShootsAndShootRoom(socket)

    const kind = 'shoots'
    const batchEmitter = new NamespacedBatchEmitter({kind, socket, objectKeyPath: 'metadata.uid'})
    const shootsWithIssuesOnly = !!filter

    try {
      // join rooms
      _.forEach(namespaces, namespace => {
        const room = filter ? `shoots_${namespace}_${filter}` : `shoots_${namespace}`
        joinRoom(socket, room)
      })

      // fetch shoots
      const shootList = await shoots.list({user, shootsWithIssuesOnly})
      const batchEmitObjects = _
        .chain(batchEmitter)
        .bindKey('batchEmitObjects')
        .ary(2)
        .value()

      _
        .chain(shootList)
        .get('items')
        .groupBy('metadata.namespace')
        .forEach(batchEmitObjects)
        .commit()
    } catch (error) {
      logger.error('Socket %s: failed to subscribe to shoots: %s', socket.id, error)
      socket.emit('subscription_error', {
        kind,
        code: 500,
        message: `Failed to fetch shoots for all namespaces`
      })
    }
    batchEmitter.flush()
    socket.emit('batchNamespacedEventsDone', {
      kind,
      namespaces
    })
  }

  // handle socket connections
  shootsNsp.on('connection', socket => {
    logger.debug('Socket %s connected', socket.id)

    socket.on('disconnect', onDisconnect)
    socket.on('subscribeAllShoots', async ({filter}) => {
      const user = getUserFromSocket(socket)
      const projectList = await projects.list({user})
      const namespaces = _.map(projectList, 'metadata.namespace')

      if (await administrators.isAdmin(user)) {
        subscribeShootsAdmin({socket, user, namespaces, filter})
      } else {
        const namespacesAndFilters = _.map(namespaces, (namespace) => { return { namespace, filter } })
        subscribeShoots({socket, namespacesAndFilters, projectList})
      }
    })
    socket.on('subscribeShoots', async ({namespaces}) => {
      const user = getUserFromSocket(socket)
      const projectList = await projects.list({user})
      subscribeShoots({namespacesAndFilters: namespaces, socket, projectList})
    })
    socket.on('subscribeShoot', async ({name, namespace}) => {
      leaveShootsAndShootRoom(socket)

      const kind = 'shoot'
      const user = getUserFromSocket(socket)
      const batchEmitter = new NamespacedBatchEmitter({kind, socket, objectKeyPath: 'metadata.uid'})
      try {
        const projectList = await projects.list({user})
        const project = _.find(projectList, ['metadata.namespace', namespace])
        if (project) {
          const room = `shoot_${namespace}_${name}`
          joinRoom(socket, room)

          const shoot = await shoots.read({user, name, namespace})
          batchEmitter.batchEmitObjects([shoot], namespace)
        }
      } catch (error) {
        logger.error('Socket %s: failed to subscribe to shoot: (%s)', socket.id, error.code, error)
        socket.emit('subscription_error', {
          kind,
          code: error.code,
          message: 'Failed to fetch shoot'
        })
      }
      batchEmitter.flush()

      socket.emit('shootSubscriptionDone', {kind, target: {name, namespace}})
    })
  })
  socketAuthentication(shootsNsp)
}

function setupJournalsNamespace (journalsNsp) {
  const cache = getJournalCache()

  journalsNsp.on('connection', socket => {
    logger.debug('Socket %s connected', socket.id)

    socket.on('disconnect', onDisconnect)
    socket.on('subscribeIssues', async () => {
      leaveIssuesRoom(socket)

      const kind = 'issues'

      const user = getUserFromSocket(socket)
      try {
        if (await administrators.isAdmin(user)) {
          joinRoom(socket, 'issues')

          const batchEmitter = new EventsEmitter({kind, socket})
          batchEmitter.batchEmitObjectsAndFlush(cache.getIssues())
        } else {
          logger.warn('Socket %s: user %s tried to fetch journal but is no admin', socket.id, user.email)
          socket.emit('subscription_error', {kind, code: 403, message: 'Forbidden'})
        }
      } catch (error) {
        logger.error('Socket %s: failed to fetch issues: %s', socket.id, error)
        socket.emit('subscription_error', {kind, code: 500, message: 'Failed to fetch issues'})
      }
    })
    socket.on('subscribeComments', async ({name, namespace}) => {
      leaveCommentsRooms(socket)

      const kind = 'comments'

      const user = getUserFromSocket(socket)
      try {
        if (await administrators.isAdmin(user)) {
          const room = `comments_${namespace}/${name}`
          joinRoom(socket, room)

          const batchEmitter = new EventsEmitter({kind, socket})
          const numbers = cache.getIssueNumbersForNameAndNamespace({name, namespace})
          for (const number of numbers) {
            try {
              await getIssueComments({number})
                .reduce((accumulator, comments) => batchEmitter.batchEmitObjects(comments))
            } catch (err) {
              logger.error('Socket %s: failed to fetch comments for %s/%s issue %s: %s', socket.id, namespace, name, number, err)
              socket.emit('subscription_error', {kind, code: 500, message: `Failed to fetch comments for issue ${number}`})
            }
          }
          batchEmitter.flush()
        } else {
          logger.warn('Socket %s: user %s tried to fetch journal comments but is no admin', socket.id, user.email)
          socket.emit('subscription_error', {kind, code: 403, message: 'Forbidden'})
        }
      } catch (error) {
        logger.error('Socket %s: failed to fetch comments for %s/%s: %s', socket.id, namespace, name, error)
        socket.emit('subscription_error', {kind, code: 500, message: 'Failed to fetch comments'})
      }
    })
    socket.on('unsubscribeComments', () => {
      leaveCommentsRooms(socket)
    })
  })
  socketAuthentication(journalsNsp)
}

function init () {
  const io = socketIO({
    path: '/api/events',
    serveClient: false
  })

  // setup namespaces
  setupShootsNamespace(io.of('/shoots'))
  setupJournalsNamespace(io.of('/journals'))

  // start watches
  _.forEach(watches, (watch, resourceName) => {
    try {
      watch(io)
    } catch (err) {
      logger.error(`watch ${resourceName} error`, err)
    }
  })
  // return io instance
  return io
}

module.exports = init
