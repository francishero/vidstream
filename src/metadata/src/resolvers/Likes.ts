import {
  Resolver,
  Authorized,
  Mutation,
  Arg,
  Ctx,
  UnauthorizedError,
  registerEnumType,
} from 'type-graphql';
import { VideoLike } from '@me/common/db/models/VideoLike';
import { CommentLike } from '@me/common/db/models/CommentLike';
import { Comment } from '@me/common/db/models/Comment';
import { Video } from '@me/common/db/models/Video';
import { User } from '@me/common/db/models/User';
import { IdGen } from '@me/common/utils/IdGen';
import { Context } from '../context';
import { getManager } from 'typeorm';
import { LikeType } from '../types';

registerEnumType(LikeType, {
  name: 'LikeType',
  description:
    'Type of like operation. User has liked/disliked or removed their previous response.',
});

type UpdateOperation = {
  entity: CommentLike | VideoLike | Comment | Video;
  operation: 'remove' | 'save';
};

class LikeHelpers {
  static editParent(
    parent: Comment | Video,
    liked: LikeType,
    entity?: CommentLike | VideoLike
  ) {
    if (!entity) {
      if (liked === LikeType.Liked) {
        parent.likes++;
      } else {
        parent.dislikes++;
      }

      return;
    }

    if (liked === LikeType.Liked) {
      // User changed his earlier response to like
      parent.dislikes--;
      parent.likes++;
    } else if (liked === LikeType.Disliked) {
      // User changed his earlier response to dislike
      parent.dislikes++;
      parent.likes--;
    } else {
      // User changed removed his earlier response
      if (entity.liked === LikeType.Liked) {
        parent.likes--;
      } else {
        parent.dislikes--;
      }
    }
  }

  static async saveUpdates(entities: Array<UpdateOperation>) {
    await getManager().transaction(async transactionManager => {
      for (const entity of entities) {
        switch (entity.operation) {
          case 'save':
            await transactionManager.save(entity.entity);
            break;
          case 'remove':
            await transactionManager.remove(entity.entity);
            break;
        }
      }
    });
  }

  static async createEntry(
    parent: Comment | Video,
    user: User,
    liked: LikeType,
    entity?: VideoLike | CommentLike
  ): Promise<VideoLike | CommentLike | undefined> {
    if (!parent || (!entity && liked === LikeType.Unliked)) {
      throw new Error('Invalid operation');
    }

    if (entity) {
      if (entity.liked !== liked) {
        throw new Error('Invalid operation');
      }

      LikeHelpers.editParent(parent, liked, entity);
      entity.liked = liked;

      await LikeHelpers.saveUpdates([
        {
          entity,
          operation: liked === LikeType.Unliked ? 'remove' : 'save',
        },
        {
          entity: parent,
          operation: 'save',
        },
      ]);

      return liked === LikeType.Unliked ? undefined : entity;
    }

    LikeHelpers.editParent(parent, liked);
    const clazz = parent instanceof Comment ? CommentLike : VideoLike;
    entity = new clazz();
    entity.liked = liked;
    entity.id = IdGen.encode(
      `${user.username}-${clazz.itemType}-${Date.now()}`
    );
    entity.liked = liked;
    entity.user = user;

    if (entity instanceof CommentLike) {
      parent = parent as Comment;
      entity.comment = parent;
    } else {
      parent = parent as Video;
      entity.video = parent as Video;
    }

    await LikeHelpers.saveUpdates([
      {
        entity,
        operation: 'save',
      },
      {
        entity: parent,
        operation: 'save',
      },
    ]);

    return entity;
  }
}

@Resolver(CommentLike)
export class CommentLikeResolver {
  @Authorized()
  @Mutation(() => CommentLike, { nullable: true })
  async likeComment(
    @Arg('id') id: string,
    @Arg('liked', () => LikeType) liked: LikeType,
    @Ctx() ctx: Context
  ): Promise<CommentLike | undefined> {
    if (!ctx.user) {
      throw new UnauthorizedError();
    }

    let like = await CommentLike.findOne({
      where: {
        user: {
          username: ctx.user.username,
        },
        comment: {
          id,
        },
      },
    });

    const comment = await Comment.findOneOrFail({
      where: {
        user: {
          username: IdGen.decode(id).split('-')[0],
        },
        id,
      },
    });

    const user = await User.findOneOrFail({
      where: {
        username: ctx.user.username,
      },
    });

    return LikeHelpers.createEntry(comment, user, liked, like) as Promise<
      CommentLike | undefined
    >;
  }
}

@Resolver(VideoLike)
export class VideoLikeResolver {
  @Authorized()
  @Mutation(() => VideoLike, { nullable: true })
  async likeVideo(
    @Arg('id') id: string,
    @Arg('liked', () => LikeType) liked: LikeType,
    @Ctx() ctx: Context
  ): Promise<VideoLike | undefined> {
    if (!ctx.user) {
      throw new UnauthorizedError();
    }

    let entity = await VideoLike.findOne({
      where: {
        user: {
          username: ctx.user.username,
        },
        video: {
          id,
        },
      },
    });

    const parent = await Video.findOneOrFail({
      where: {
        id,
      },
    });

    const user = await User.findOneOrFail({
      where: {
        username: ctx.user.username,
      },
    });

    return LikeHelpers.createEntry(parent, user, liked, entity) as Promise<
      VideoLike | undefined
    >;
  }
}
