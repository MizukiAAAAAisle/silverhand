import { useQuery } from "@tanstack/react-query";
import { apiPaths, SelfEmailSchema } from "@silverhand/shared";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

/** The viewer's own email, read-only. Only `GET /api/me` carries it. */
export function AccountEmail({ userId }: { userId: string }): JSX.Element | null {
  const email = useQuery({
    queryKey: ["me-email", userId],
    queryFn: async () => SelfEmailSchema.parse(await api(apiPaths.me)).email ?? null,
  });
  if (!email.data) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-text-secondary">{t("appShell.email")}</p>
      <p className="truncate text-sm text-text-primary">{email.data}</p>
    </div>
  );
}
