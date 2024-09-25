import { User } from "@neynar/nodejs-sdk/build/neynar-api/v2";
import { Cooldown } from "@prisma/client";
import { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher } from "@remix-run/react";
import { ArrowUpRight, Loader } from "lucide-react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { Button } from "~/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { banAction, cooldown24Action } from "~/lib/cast-actions.server";
import { db } from "~/lib/db.server";
import { neynar } from "~/lib/neynar.server";
import { actionToInstallLink } from "~/lib/utils";
import { requireUser, requireUserCanModerateChannel, successResponse } from "~/lib/utils.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser({ request });
  const moderatedChannel = await requireUserCanModerateChannel({ userId: user.id, channelId: params.id! });

  const cooldowns = await db.cooldown.findMany({
    where: {
      channelId: moderatedChannel.id,
      active: true,
      OR: [{ expiresAt: { gt: new Date() } }, { expiresAt: null }],
    },
  });

  const decoratedCooldowns = await decorateCooldowns(cooldowns);
  const banInstallLink = actionToInstallLink(banAction);
  const cooldownInstallLink = actionToInstallLink(cooldown24Action);

  return typedjson({
    user,
    moderatedChannel,
    cooldowns: decoratedCooldowns,
    banInstallLink,
    cooldownInstallLink,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const user = await requireUser({ request });
  const moderatedChannel = await requireUserCanModerateChannel({ userId: user.id, channelId: params.id! });

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "remove") {
    const affectedUserId = formData.get("affectedUserId") as string;

    await db.cooldown.update({
      where: {
        affectedUserId_channelId: {
          channelId: moderatedChannel.id,
          affectedUserId,
        },
      },
      data: {
        active: false,
      },
    });
  }

  return successResponse({
    request,
    message: "Removed",
  });
}

export default function Screen() {
  const { cooldowns, cooldownInstallLink, banInstallLink } = useTypedLoaderData<typeof loader>();

  const banned = cooldowns.filter((c) => !c.expiresAt);
  const cooldown = cooldowns.filter((c) => !!c.expiresAt);

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <div className="flex justify-between items-end border-b pb-2">
          <p className="font-medium">Bans</p>
          <Link
            className="text-[8px] no-underline hover:underline uppercase tracking-wide"
            target="_blank"
            rel="noreferrer"
            to={banInstallLink}
          >
            Install Cast Action
            <ArrowUpRight className="inline w-2 h-2 ml-[2px] -mt-[2px] text-primary" />
          </Link>
        </div>

        {banned.length === 0 ? (
          <p className="p-4 rounded-md border text-xs">None yet.</p>
        ) : (
          <div className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">User</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {banned.map((c) => (
                  <TableRow key={c.affectedUserId}>
                    <TableCell>
                      <Link to={`https://warpcast.com/${c.user.username}`}>@{c.user.username}</Link>
                    </TableCell>
                    <TableCell title={c.createdAt.toISOString()}>
                      {c.createdAt.toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <RemoveButton data={c} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {/* <section className="space-y-2">
        <div className="flex justify-between items-end border-b pb-2">
          <p className="font-medium">Cooldowns</p>
          <Link
            className="text-[8px] no-underline hover:underline uppercase tracking-wide"
            target="_blank"
            rel="noreferrer"
            to={cooldownInstallLink}
          >
            Install Cast Action
            <ArrowUpRight className="inline w-2 h-2 ml-[2px] -mt-[2px] text-primary" />
          </Link>
        </div>{" "}
        {cooldown.length === 0 ? (
          <p className="p-4 rounded-md border text-xs">None yet.</p>
        ) : (
          <div className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">User</TableHead>
                  <TableHead className="hidden sm:table-cell">Created</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cooldown.map((c) => (
                  <TableRow key={c.affectedUserId}>
                    <TableCell>
                      <Link to={`https://warpcast.com/${c.user.username}`}>@{c.user.username}</Link>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell" title={c.createdAt.toISOString()}>
                      {c.createdAt.toLocaleDateString()}
                    </TableCell>
                    <TableCell title={c.expiresAt!.toISOString()}>
                      {c.expiresAt!.toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <RemoveButton data={c} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section> */}
    </div>
  );
}

function RemoveButton(props: { data: Cooldown }) {
  const fetcher = useFetcher<typeof loader>();
  const isLoading = fetcher.state !== "idle";

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="affectedUserId" value={props.data.affectedUserId} />
      <Button size={"sm"} name="intent" value="remove" type="submit" variant={"ghost"}>
        {isLoading ? <Loader className="w-4 h-4 animate-spin" /> : "Remove"}
      </Button>
    </fetcher.Form>
  );
}

/**
 * This won't scale but should be fine for order of
 * magnitude based on current usage and the alternative
 * is a data change / backfill.
 */
async function decorateCooldowns(cooldowns: Cooldown[]) {
  const users: User[] = [];

  // batch 100 fids at a time
  for (let i = 0; i < cooldowns.length; i += 100) {
    const batch = cooldowns.slice(i, i + 100);
    const _users = await neynar
      .fetchBulkUsers(batch.map((c) => Number(c.affectedUserId)))
      .then((r) => r.users);
    users.push(..._users);
  }

  return cooldowns.map((c) => {
    const user = users.find((u) => u.fid === Number(c.affectedUserId))!;
    return {
      ...c,
      user,
    };
  });
}
