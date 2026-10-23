"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ExternalLink, ImageIcon, Trash2, Unlink } from "lucide-react";

import { detachAccountAction, setProfileAvatarAction } from "@/app/actions/creators";
import { RemoveAccountDialog } from "@/components/library/remove-creator-dialog";
import { ActionMenu, type ActionMenuItem } from "@/components/ui/action-menu";
import { useToast } from "@/components/ui/toast";
import { PLATFORM_LABELS, formatHandle } from "@/lib/creators/labels";
import type { CreatorAccountSummary } from "@/lib/creators/profile-service";

interface AccountActionsProps {
  profileId: number;
  profileName: string;
  account: CreatorAccountSummary;
  /** How many accounts the person has; the last one cannot be unlinked. */
  accountCount: number;
  /** Whether this account's avatar already represents the person. */
  isAvatar: boolean;
  researchListNames: string[];
}

/**
 * Secondary actions for one platform account on a creator page: open it on
 * its platform, use its picture for the person, split it off into a creator
 * of its own, or remove it with its cache.
 */
export function AccountActions({
  profileId,
  profileName,
  account,
  accountCount,
  isAvatar,
  researchListNames,
}: AccountActionsProps) {
  const router = useRouter();
  const { showToast, toastElement } = useToast();
  const [removing, setRemoving] = useState(false);
  const label = `${formatHandle(account.handle) ?? account.displayName} on ${PLATFORM_LABELS[account.platform]}`;

  const chooseAvatar = async (): Promise<void> => {
    const outcome = await setProfileAvatarAction(profileId, account.id);
    if (!outcome.ok) {
      showToast(outcome.message ?? "The profile picture could not be changed.", "error");
      return;
    }
    showToast(
      `${profileName} now uses the picture from ${PLATFORM_LABELS[account.platform]}.`,
      "success",
    );
  };

  const detach = async (): Promise<void> => {
    const outcome = await detachAccountAction(account.id);
    if (!outcome.ok || outcome.profileId === undefined) {
      showToast(outcome.message ?? "The account could not be unlinked.", "error");
      return;
    }
    // This tab no longer belongs here; the person's page announces the change.
    router.replace(
      `/creators/${profileId}?notice=${encodeURIComponent(`${label} is now a creator of its own.`)}`,
      { scroll: false },
    );
  };

  const items: ActionMenuItem[] = [
    {
      id: "open",
      label: `Open on ${PLATFORM_LABELS[account.platform]}`,
      icon: <ExternalLink />,
      onSelect: () => window.open(account.channelUrl, "_blank", "noopener,noreferrer"),
    },
  ];
  if (account.avatarUrl && !isAvatar) {
    items.push({
      id: "avatar",
      label: "Use this profile picture",
      hint: `Shows this ${PLATFORM_LABELS[account.platform]} picture for ${profileName}.`,
      icon: <ImageIcon />,
      onSelect: () => void chooseAvatar(),
    });
  }
  if (accountCount > 1) {
    items.push({
      id: "detach",
      label: "Unlink into its own creator",
      hint: "Keeps the account and its cache, on a separate card.",
      icon: <Unlink />,
      onSelect: () => void detach(),
    });
  }
  items.push({
    id: "remove",
    label: accountCount > 1 ? "Remove this account" : "Remove creator",
    hint: "Deletes the account and everything cached for it.",
    icon: <Trash2 />,
    destructive: true,
    separated: true,
    onSelect: () => setRemoving(true),
  });

  return (
    <>
      <ActionMenu label={`More actions for ${label}`} items={items} />
      <RemoveAccountDialog
        open={removing}
        onClose={() => setRemoving(false)}
        account={{ ...account, researchListNames }}
        profileName={profileName}
        accountCount={accountCount}
        onRemoved={(message) => {
          if (accountCount === 1) {
            router.replace(`/?removed=${encodeURIComponent(profileName)}`);
            return;
          }
          router.replace(`/creators/${profileId}?notice=${encodeURIComponent(message)}`, {
            scroll: false,
          });
        }}
        onError={(message) => showToast(message, "error")}
      />
      {toastElement}
    </>
  );
}
