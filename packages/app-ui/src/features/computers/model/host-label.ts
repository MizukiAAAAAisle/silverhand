import { HOST_DISPLAY_LABEL_MAX_LENGTH, UpdateHostInputSchema } from "@silverhand/shared";
import type { ZodError } from "zod";
import { t } from "@/lib/i18n";

/**
 * Client-side gate for every computer-name write (#task:1849).
 *
 * The authority is the shared `UpdateHostInputSchema` — trim → at most
 * `HOST_DISPLAY_LABEL_MAX_LENGTH`, empty → `null` (clear the custom
 * label). Editors call in here instead of re-deriving the bound, and
 * they carry NO DOM `maxLength`: the schema counts the TRIMMED string
 * while a length attribute caps the RAW one, so capping at the schema's
 * bound would cut a padded paste short and save a name the user never
 * typed. That silent rewrite is precisely what shiki's ruling took out
 * of the server, so the renderer must not reintroduce it one layer up.
 *
 * The copy is ours, not Zod's: the schema's messages name the wire
 * field and are written for API consumers. We read the issue *code* to
 * pick a line, so the wording is product copy while the rule stays in
 * one place. Same shape as `features/identity/display-name`, kept
 * separate on purpose — a different field with a different schema.
 */

/**
 * The reason `candidate` cannot be saved as a computer name, or `null`
 * when it can. `null` input means "clear the custom label", which is
 * always allowed.
 */
export function rejectHostLabel(candidate: string | null): string | null {
  const parsed = UpdateHostInputSchema.safeParse({
    display_label: candidate,
  });
  return parsed.success ? null : describeRejection(parsed.error);
}

function describeRejection(error: ZodError<unknown>): string {
  const code = error.issues[0]?.code;
  if (code === "too_big") {
    return t("computers.nameTooLong", { max: HOST_DISPLAY_LABEL_MAX_LENGTH });
  }
  return t("computers.thatComputerNameCannot");
}
