// @flow
const { db } = require('./db');
import { sendChannelNotificationQueue } from 'shared/bull/queues';
import type { DBChannel } from 'shared/types';

const getChannelsByCommunity = (
  communityId: string
): Promise<Array<DBChannel>> => {
  return db
    .table('channels')
    .getAll(communityId, { index: 'communityId' })
    .filter(channel => db.not(channel.hasFields('deletedAt')))
    .run();
};

/*
  If a non-user is viewing a community page, they should only see threads
  from public channels. We use this function to return an array of channelIds
  that are public, and pass them into a getThreads function
*/
const getPublicChannelsByCommunity = (
  communityId: string
): Promise<Array<string>> => {
  return db
    .table('channels')
    .getAll(communityId, { index: 'communityId' })
    .filter(channel => db.not(channel.hasFields('deletedAt')))
    .filter({ isPrivate: false })
    .map(c => c('id'))
    .run();
};

/*
  If a user is viewing a community, they should see threads from all public channels as well as from private channels they are a member of.

  This function returns an array of objects with the field 'id' that corresponds
  to a channelId. This array of IDs will be passed into a threads method which
  will only return threads in those channels
*/
const getChannelsByUserAndCommunity = async (
  communityId: string,
  userId: string
): Promise<Array<string>> => {
  const channels = await db
    .table('channels')
    .getAll(communityId, { index: 'communityId' })
    .run();

  const channelIds = channels.map(c => c.id);
  const publicChannels = channels.filter(c => !c.isPrivate).map(c => c.id);

  const usersChannels = await db
    .table('usersChannels')
    .getAll(userId, { index: 'userId' })
    .filter(usersChannel =>
      db.expr(channelIds).contains(usersChannel('channelId'))
    )
    .filter({ isMember: true })
    .run();

  const usersChannelsIds = usersChannels.map(c => c.channelId);
  const allPossibleChannels = [...publicChannels, ...usersChannelsIds];
  const distinct = allPossibleChannels.filter((x, i, a) => a.indexOf(x) == i);
  return distinct;
};

const getChannelsByUser = (userId: string): Promise<Array<DBChannel>> => {
  return (
    db
      .table('usersChannels')
      // get all the user's channels
      .getAll(userId, { index: 'userId' })
      // only return channels where the user is a member
      .filter({ isMember: true })
      // get the channel objects for each channel
      .eqJoin('channelId', db.table('channels'))
      // get rid of unnecessary info from the usersChannels object on the left
      .without({ left: ['id', 'channelId', 'userId', 'createdAt'] })
      // zip the tables
      .zip()
      // ensure we don't return any deleted channels
      .filter(channel => db.not(channel.hasFields('deletedAt')))
      .run()
  );
};

const getChannelBySlug = (
  channelSlug: string,
  communitySlug: string
): Promise<DBChannel> => {
  const lowercaseChannelSlug = channelSlug.toLowerCase();
  const lowercaseCommunitySlug = communitySlug.toLowerCase();

  return db
    .table('channels')
    .filter(channel =>
      channel('slug')
        .eq(lowercaseChannelSlug)
        .and(db.not(channel.hasFields('deletedAt')))
    )
    .eqJoin('communityId', db.table('communities'))
    .filter({ right: { slug: lowercaseCommunitySlug } })
    .run()
    .then(result => {
      if (result && result[0]) {
        return result[0].left;
      }
      return null;
    });
};

const getChannelById = (id: string) => {
  return db
    .table('channels')
    .get(id)
    .run();
};

type GetChannelByIdArgs = {|
  id: string,
|};

type GetChannelBySlugArgs = {|
  slug: string,
  communitySlug: string,
|};

export type GetChannelArgs = GetChannelByIdArgs | GetChannelBySlugArgs;

const getChannels = (channelIds: Array<string>): Promise<Array<DBChannel>> => {
  return db
    .table('channels')
    .getAll(...channelIds)
    .filter(channel => db.not(channel.hasFields('deletedAt')))
    .run();
};

const getChannelMetaData = (channelId: string): Promise<Array<number>> => {
  const getThreadCount = db
    .table('threads')
    .getAll(channelId, { index: 'channelId' })
    .count()
    .run();

  const getMemberCount = db
    .table('usersChannels')
    .getAll(channelId, { index: 'channelId' })
    .filter({ isBlocked: false, isPending: false })
    .count()
    .run();

  return Promise.all([getThreadCount, getMemberCount]);
};

type GroupedCount = {
  group: string,
  reduction: number,
};

const getChannelsThreadCounts = (
  channelIds: Array<string>
): Promise<Array<GroupedCount>> => {
  return db
    .table('threads')
    .getAll(...channelIds, { index: 'channelId' })
    .group('channelId')
    .count()
    .run();
};

const getChannelsMemberCounts = (
  channelIds: Array<string>
): Promise<Array<GroupedCount>> => {
  return db
    .table('usersChannels')
    .getAll(...channelIds, { index: 'channelId' })
    .filter({ isBlocked: false, isPending: false, isMember: true })
    .group('channelId')
    .count()
    .run();
};

export type CreateChannelInput = {
  input: {
    communityId: string,
    name: string,
    description: string,
    slug: string,
    isPrivate: boolean,
    isDefault: boolean,
  },
};

export type EditChannelInput = {
  input: {
    channelId: string,
    name: string,
    description: string,
    slug: string,
    isPrivate: Boolean,
  },
};

const createChannel = (
  {
    input: { communityId, name, slug, description, isPrivate, isDefault },
  }: CreateChannelInput,
  userId: string
): Promise<DBChannel> => {
  const lowercaseSlug = slug.toLowerCase();
  return db
    .table('channels')
    .insert(
      {
        communityId,
        createdAt: new Date(),
        name,
        description,
        slug: lowercaseSlug,
        isPrivate,
        isDefault: isDefault ? true : false,
      },
      { returnChanges: true }
    )
    .run()
    .then(result => result.changes[0].new_val)
    .then(channel => {
      // only trigger a new channel notification is the channel is public
      if (!channel.isPrivate) {
        sendChannelNotificationQueue.add({ channel, userId });
      }

      return channel;
    });
};

const createGeneralChannel = (
  communityId: string,
  userId: string
): Promise<DBChannel> => {
  return createChannel(
    {
      input: {
        name: 'General',
        slug: 'general',
        description: 'General Chatter',
        communityId,
        isPrivate: false,
        isDefault: true,
      },
    },
    userId
  );
};

const editChannel = async ({
  input: { name, slug, description, isPrivate, channelId },
}: EditChannelInput): Promise<DBChannel> => {
  const lowercaseSlug = slug.toLowerCase();

  const channelRecord = await db
    .table('channels')
    .get(channelId)
    .run()
    .then(result => {
      return Object.assign({}, result, {
        name,
        description,
        slug: lowercaseSlug,
        isPrivate,
      });
    });

  return db
    .table('channels')
    .get(channelId)
    .update({ ...channelRecord }, { returnChanges: 'always' })
    .run()
    .then(result => {
      // if an update happened
      if (result.replaced === 1) {
        return result.changes[0].new_val;
      }

      // an update was triggered from the client, but no data was changed
      if (result.unchanged === 1) {
        return result.changes[0].old_val;
      }

      return null;
    });
};

/*
  We delete data non-destructively, meaning the record does not get cleared
  from the db.
*/
const deleteChannel = (channelId: string): Promise<Boolean> => {
  return db
    .table('channels')
    .get(channelId)
    .update(
      {
        deletedAt: new Date(),
        slug: db.uuid(),
      },
      {
        returnChanges: true,
        nonAtomic: true,
      }
    )
    .run();
};

const getChannelMemberCount = (channelId: string): number => {
  return db
    .table('channels')
    .get(channelId)('members')
    .count()
    .run();
};

const archiveChannel = (channelId: string) => {
  return db
    .table('channels')
    .get(channelId)
    .update({ archivedAt: new Date() }, { returnChanges: 'always' })
    .run()
    .then(result => result.changes[0].new_val || result.changes[0].old_val);
};

const restoreChannel = (channelId: string) => {
  return db
    .table('channels')
    .get(channelId)
    .update({ archivedAt: db.literal() }, { returnChanges: 'always' })
    .run()
    .then(result => result.changes[0].new_val || result.changes[0].old_val);
};

const archiveAllPrivateChannels = (communityId: string) => {
  return db
    .table('channels')
    .getAll(communityId, { index: 'communityId' })
    .filter({ isPrivate: true })
    .update({ archivedAt: new Date() })
    .run();
};

module.exports = {
  getChannelBySlug,
  getChannelById,
  getChannelMetaData,
  getChannelsByUser,
  getChannelsByCommunity,
  getPublicChannelsByCommunity,
  getChannelsByUserAndCommunity,
  createChannel,
  createGeneralChannel,
  editChannel,
  deleteChannel,
  getChannelMemberCount,
  getChannelsMemberCounts,
  getChannelsThreadCounts,
  getChannels,
  archiveChannel,
  restoreChannel,
  archiveAllPrivateChannels,
};
