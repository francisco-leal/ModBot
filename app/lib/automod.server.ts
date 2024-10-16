import { Cast } from "@neynar/nodejs-sdk/build/neynar-api/v2";
import * as Sentry from "@sentry/remix";
import { ModeratedChannel, ModerationLog } from "@prisma/client";
import { v4 as uuid } from "uuid";
import { db } from "~/lib/db.server";
import { neynar } from "~/lib/neynar.server";
import { getModerators } from "~/lib/utils.server";
import { Rule, User } from "~/rules/rules.type";
import { Action, actionFunctions, isCohost, ruleFunctions } from "~/lib/validations.server";
import { FullModeratedChannel, WebhookCast } from "~/lib/types";
import { getWarpcastChannelOwner } from "~/lib/warpcast.server";
import { PlanType, userPlans } from "~/lib/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function cooldown({ channel, user, action }: { channel: string; user: User; action: Action }) {
  // const { duration } = (action as any).args;
  // return db.cooldown.upsert({
  //   where: {
  //     affectedUserId_channelId: {
  //       affectedUserId: String(cast.author.fid),
  //       channelId: channel,
  //     },
  //   },
  //   update: {
  //     active: true,
  //     expiresAt: new Date(Date.now() + duration * 60 * 60 * 1000),
  //   },
  //   create: {
  //     affectedUserId: String(cast.author.fid),
  //     channelId: channel,
  //     expiresAt: new Date(Date.now() + duration * 60 * 60 * 1000),
  //   },
  // });
}

export async function mute({ channel, user }: { channel: string; user: User; action: Action }) {
  // return db.cooldown.upsert({
  //   where: {
  //     affectedUserId_channelId: {
  //       affectedUserId: String(cast.author.fid),
  //       channelId: channel,
  //     },
  //   },
  //   update: {
  //     active: true,
  //     expiresAt: null,
  //   },
  //   create: {
  //     affectedUserId: String(cast.author.fid),
  //     channelId: channel,
  //     expiresAt: null,
  //   },
  // });
}

export async function hideQuietly({
  channel,
  user,
  options,
}: {
  channel: string;
  user?: User;
  action: Action;
  options?: {
    executeOnProtocol?: boolean;
  };
}) {
  console.log("cannot join", channel, user?.username);
  return Promise.resolve();
  // if (options?.executeOnProtocol) {
  //   await unlike({ channel, user });
  // } else {
  //   return Promise.resolve();
  // }
}

export async function addToBypass({ channel, user }: { channel: string; user: User; action: Action }) {
  // const moderatedChannel = await db.moderatedChannel.findFirstOrThrow({
  //   where: {
  //     id: channel,
  //   },
  // });
  // const existing = moderatedChannel.excludeUsernamesParsed || [];
  // if (existing.some((u) => u.value === cast.author.fid)) {
  //   return;
  // }
  // existing.push({
  //   value: cast.author.fid,
  //   label: cast.author.username,
  //   icon: cast.author.pfp_url,
  // });
  // return db.moderatedChannel.update({
  //   where: {
  //     id: channel,
  //   },
  //   data: {
  //     excludeUsernames: JSON.stringify(existing),
  //   },
  // });
}

export async function downvote({ channel, user, action }: { channel: string; user: User; action: Action }) {
  // if (action.type !== "downvote") {
  //   return;
  // }
  // const { voterFid, voterAvatarUrl, voterUsername } = action.args;
  // await db.moderatedChannel.findFirstOrThrow({
  //   where: {
  //     id: channel,
  //   },
  // });
  // await db.downvote.upsert({
  //   where: {
  //     fid_castHash: {
  //       fid: String(voterFid),
  //       castHash: cast.hash,
  //     },
  //   },
  //   update: {},
  //   create: {
  //     castHash: cast.hash,
  //     channelId: channel,
  //     fid: voterFid,
  //     username: voterUsername,
  //     avatarUrl: voterAvatarUrl,
  //   },
  // });
}

/**
 * This does not check permissions
 */
export async function grantRole({ channel, user, action }: { channel: string; user: User; action: Action }) {}

export async function unlike(props: { user: User; channel: string }) {}

export async function ban({ channel, user }: { channel: string; user: User; action: Action }) {}

export type ValidateCastArgs = {
  moderatedChannel: FullModeratedChannel;
  user: User;
  executeOnProtocol?: boolean;
  simulation?: boolean;
};

export async function validateCast({
  moderatedChannel,
  user,
  executeOnProtocol = false,
  simulation = false,
}: ValidateCastArgs): Promise<Array<ModerationLog>> {
  const logs: Array<ModerationLog> = [];

  if (!moderatedChannel) {
    throw new Error("Moderated channel not found");
  }

  if (!user) {
    throw new Error("User not found");
  }

  const isExcluded = moderatedChannel.excludeUsernamesParsed?.some((u) => u.value === user.fid);

  const isOwner = Number(moderatedChannel.userId) === user.fid;

  if (isExcluded || isOwner) {
    const message = isOwner ? `@${user.username} is the channel owner` : `@${user.username} is in the bypass list.`;

    console.log(message);

    const [, log] = await Promise.all([
      simulation ? Promise.resolve() : Promise.resolve(), // invite to channel
      logModerationAction(moderatedChannel.id, "like", message, user, simulation),
    ]);

    logs.push(log);
    return logs;
  }

  if (!moderatedChannel.inclusionRuleSetParsed?.ruleParsed?.conditions?.length) {
    console.log(`[${moderatedChannel.id}] No rules for channel.`);
    const log = await logModerationAction(
      moderatedChannel.id,
      "hideQuietly",
      `/${moderatedChannel.id} is not configured to use ModBot`,
      user,
      simulation
    );
    logs.push(log);
    return logs;
  }

  if (moderatedChannel.exclusionRuleSetParsed?.ruleParsed?.conditions?.length) {
    const exclusionCheck = await evaluateRules(
      moderatedChannel,
      user,
      moderatedChannel.exclusionRuleSetParsed?.ruleParsed
    );

    // exclusion overrides inclusion so we check it first
    // some checks are expensive so we do this serially
    if (exclusionCheck.passedRule) {
      for (const action of moderatedChannel.exclusionRuleSetParsed.actionsParsed) {
        if (!simulation) {
          const actionFn = actionFunctions[action.type];

          await actionFn({
            channel: moderatedChannel.id,
            user,
            action,
            options: {
              executeOnProtocol,
            },
          }).catch((e) => {
            Sentry.captureMessage(`Error in ${action.type} action`, {
              extra: {
                user,
                action,
              },
            });
            console.error(e?.response?.data || e?.message || e);
            throw e;
          });
        }

        logs.push(
          await logModerationAction(
            moderatedChannel.id,
            action.type,
            exclusionCheck.explanation,
            user,
            simulation,
            exclusionCheck.rule
          )
        );
      }

      return logs;
    }
  }

  const inclusionCheck = await evaluateRules(
    moderatedChannel,
    user,
    moderatedChannel.inclusionRuleSetParsed?.ruleParsed
  );

  if (inclusionCheck.passedRule) {
    for (const action of moderatedChannel.inclusionRuleSetParsed.actionsParsed) {
      if (!simulation) {
        const actionFn = actionFunctions[action.type];

        await actionFn({
          channel: moderatedChannel.id,
          user,
          action,
          options: {
            executeOnProtocol,
          },
        }).catch((e) => {
          Sentry.captureMessage(`Error in ${action.type} action`, {
            extra: {
              user,
              action,
            },
          });
          console.error(e?.response?.data || e?.message || e);
          throw e;
        });
      }
      logs.push(
        await logModerationAction(
          moderatedChannel.id,
          action.type,
          inclusionCheck.explanation,
          user,
          simulation,
          inclusionCheck.rule
        )
      );
    }
    return logs;
  } else {
    if (!simulation) {
      await actionFunctions["hideQuietly"]({
        channel: moderatedChannel.id,
        user,
        action: { type: "hideQuietly" },
        options: {
          executeOnProtocol,
        },
      });
    }
    logs.push(
      await logModerationAction(
        moderatedChannel.id,
        "hideQuietly",
        inclusionCheck.explanation,
        user,
        simulation,
        inclusionCheck.rule
      )
    );
  }

  return logs;
}

export async function logModerationAction(
  moderatedChannelId: string,
  actionType: string,
  reason: string,
  user: User,
  simulation: boolean,
  rule?: Rule,
  options?: {
    actor?: string;
  }
): Promise<ModerationLog> {
  if (!simulation) {
    return db.moderationLog.create({
      data: {
        channelId: moderatedChannelId,
        action: actionType,
        actor: options?.actor || "system",
        reason,
        affectedUsername: user.username || String(user.fid) || "unknown",
        affectedUserAvatarUrl: user.pfp_url,
        affectedUserFid: String(user.fid),
        castText: "",
        castHash: "",
        rule: rule ? JSON.stringify(rule) : "{}",
      },
    });
  } else {
    return {
      id: `sim-${uuid()}`,
      channelId: moderatedChannelId,
      action: actionType,
      actor: "system",
      reason,
      affectedUsername: user.username || String(user.fid) || "unknown",
      affectedUserAvatarUrl: user.pfp_url || null,
      affectedUserFid: String(user.fid),
      castHash: "",
      castText: "",
      createdAt: new Date(),
      updatedAt: new Date(),
      rule: rule ? JSON.stringify(rule) : "{}",
    };
  }
}

async function evaluateRules(
  moderatedChannel: ModeratedChannel,
  user: User,
  rule: Rule
): Promise<{
  passedRule: boolean;
  explanation: string;
  rule: Rule;
}> {
  if (rule.type === "CONDITION") {
    return evaluateRule(moderatedChannel, user, rule);
  } else if (rule.type === "LOGICAL" && rule.conditions) {
    if (rule.operation === "AND") {
      const evaluations = await Promise.all(
        rule.conditions.map((subRule) => evaluateRules(moderatedChannel, user, subRule))
      );
      if (evaluations.every((e) => e.passedRule)) {
        return {
          passedRule: true,
          explanation: `${evaluations.map((e) => e.explanation).join(", ")}`,
          rule,
        };
      } else {
        const failure = evaluations.find((e) => !e.passedRule)!;
        return { passedRule: false, explanation: `${failure.explanation}`, rule };
      }
    } else if (rule.operation === "OR") {
      const results: Array<{
        passedRule: boolean;
        explanation: string;
        rule: Rule;
      }> = [];

      for (const subRule of rule.conditions) {
        const result = await evaluateRules(moderatedChannel, user, subRule);
        results.push(result);
        if (result.passedRule) {
          return result;
        }
      }

      const explanation =
        results.length > 1
          ? `Failed all checks: ${results.map((e) => e.explanation).join(", ")}`
          : results[0].explanation;

      return {
        passedRule: false,
        explanation,
        rule,
      };
    }
  }

  return { passedRule: false, explanation: "No rules", rule };
}

async function evaluateRule(
  channel: ModeratedChannel,
  user: User,
  rule: Rule
): Promise<{ passedRule: boolean; explanation: string; rule: Rule }> {
  const check = ruleFunctions[rule.name];
  if (!check) {
    throw new Error(`No function for rule ${rule.name}`);
  }

  const result = await check({ channel, user, rule });

  return {
    passedRule: result.result,
    explanation: result.message,
    rule,
  };
}

export function isRuleTargetApplicable(target: string, cast: Cast) {
  switch (target) {
    case "all":
      return true;
    case "root":
      return cast.parent_hash == null;
    case "reply":
      return cast.parent_hash !== null;
    default:
      return true;
  }
}

export async function getUsage(moderatedChannel: FullModeratedChannel) {
  const plan = userPlans[moderatedChannel.user.plan as PlanType];
  if (!plan) {
    console.log(
      `Channel ${moderatedChannel.id}, User ${moderatedChannel.userId} has no plan`,
      moderatedChannel.user.plan
    );
    return 0;
  }

  const usages = await db.usage.findMany({
    where: {
      userId: moderatedChannel.userId,
      monthYear: new Date().toISOString().substring(0, 7),
    },
  });

  if (!usages.length) {
    console.log(
      `Channel ${moderatedChannel.id}, User ${moderatedChannel.userId} has no usage`,
      moderatedChannel.user.plan
    );
    return 0;
  }

  return usages.reduce((acc, u) => acc + u.castsProcessed, 0);
}

export async function isUserOverUsage(moderatedChannel: FullModeratedChannel, buffer = 0) {
  const plan = userPlans[moderatedChannel.user.plan as PlanType];
  if (!plan) {
    console.log(
      `Channel ${moderatedChannel.id}, User ${moderatedChannel.userId} has no plan`,
      moderatedChannel.user.plan
    );
    return false;
  }

  const usages = await db.usage.findMany({
    where: {
      userId: moderatedChannel.userId,
      monthYear: new Date().toISOString().substring(0, 7),
    },
  });

  if (!usages.length) {
    console.log(
      `Channel ${moderatedChannel.id}, User ${moderatedChannel.userId} has no usage`,
      moderatedChannel.user.plan
    );
    return false;
  }

  const totalCasts = usages.reduce((acc, u) => acc + u.castsProcessed, 0);

  const maxCastsWithBuffer = plan.maxCasts * (1 + buffer);
  if (totalCasts >= maxCastsWithBuffer) {
    return true;
  }

  return false;
}

export async function isCohostOrOwner({ fid, channel }: { fid: string; channel: string }) {
  const [isUserCohost, ownerFid] = await Promise.all([
    isCohost({
      fid: +fid,
      channel,
    }),
    getWarpcastChannelOwner({ channel }),
  ]);

  const isOwner = ownerFid === +fid;

  return isUserCohost || isOwner;
}
