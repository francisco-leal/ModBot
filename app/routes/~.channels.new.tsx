import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { errorResponse, formatZodError, getSharedEnv, requireUser } from "~/lib/utils.server";

import {
  ModeratedChannelSchema,
  actionDefinitions,
  ruleDefinitions,
  ruleNames,
} from "~/lib/validations.server";

import { db } from "~/lib/db.server";
import { getChannel, registerWebhook } from "~/lib/neynar.server";
import { commitSession, getSession } from "~/lib/auth.server";
import { ChannelForm } from "~/components/channel-form";
import { getWarpcastChannelOwner } from "~/lib/warpcast.server";
import { recoverQueue } from "~/lib/bullish.server";

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser({ request });
  const data = await request.json();

  if (process.env.NODE_ENV !== "development") {
    let leadFid: number;
    try {
      leadFid = await getWarpcastChannelOwner({ channel: data.id.replace("/", "") });
    } catch (e) {
      return errorResponse({
        request,
        message: `Couldn't find that channel. Spell it right?`,
      });
    }

    if (leadFid !== +user.id) {
      return errorResponse({
        request,
        message: `You must own the channel to setup a bot.`,
      });
    }
  }

  const channelResult = await ModeratedChannelSchema.safeParseAsync(data);

  if (!channelResult.success) {
    console.error(channelResult.error);
    return errorResponse({
      request,
      message: formatZodError(channelResult.error),
    });
  }

  if (process.env.NODE_ENV === "development") {
    console.log(channelResult.data);
  }

  const channelExists = await db.moderatedChannel.findFirst({
    where: {
      id: channelResult.data.id,
    },
  });

  if (channelExists) {
    return errorResponse({
      request,
      message: "Moderation for that channel already exists",
    });
  }

  const neynarChannel = await getChannel({ name: channelResult.data.id });

  const newChannel = await db.moderatedChannel.create({
    data: {
      id: channelResult.data.id,
      active: true,
      url: neynarChannel.url,
      user: {
        connect: {
          id: user.id,
        },
      },
      imageUrl: neynarChannel.image_url,
      banThreshold: channelResult.data.banThreshold,
      excludeCohosts: channelResult.data.excludeCohosts,
      excludeUsernames: JSON.stringify(channelResult.data.excludeUsernames),
      ruleSets: {
        create: channelResult.data.ruleSets.map((ruleSet) => {
          return {
            target: ruleSet.target,
            rule: JSON.stringify(ruleSet.ruleParsed),
            actions: JSON.stringify(ruleSet.actionsParsed),
          };
        }),
      },
    },
  });

  const [, , session] = await Promise.all([
    registerWebhook({
      rootParentUrl: neynarChannel.url,
    }),
    recoverQueue.add("recover", {
      channelId: newChannel.id,
      moderatedChannel: newChannel,
      limit: 200,
    }),
    getSession(request.headers.get("Cookie")),
  ]);

  session.flash("newChannel", "yup");

  return redirect(`/~/channels/${newChannel.id}`, {
    headers: {
      "Set-Cookie": await commitSession(session),
    },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser({ request });

  return typedjson({
    user,
    actionDefinitions,
    ruleDefinitions,
    ruleNames,
    env: getSharedEnv(),
  });
}

export default function FrameConfig() {
  const { ruleNames, ruleDefinitions, actionDefinitions } = useTypedLoaderData<typeof loader>();

  return (
    <div className="space-y-4">
      <ChannelForm
        actionDefinitions={actionDefinitions}
        ruleDefinitions={ruleDefinitions}
        ruleNames={ruleNames}
        defaultValues={{
          excludeCohosts: true,
          ruleSets: [],
        }}
      />
    </div>
  );
}
