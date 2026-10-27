import * as Select from "@radix-ui/react-select";
import {
  FILTER_SELECT_CONTENT_CLASS,
  FILTER_SELECT_TRIGGER_CLASS,
  FilterSelectItem,
} from "@/components/ui/filter-select";
import { ChevronDownIcon, LanguageIcon } from "@/icons";
import {
  LOCALE_PREFERENCES,
  setLocalePreference,
  t,
  useLocalePreference,
  type LocalePreference,
} from "@/lib/i18n";
import { SettingsHeading } from "./settings-heading";

export function LanguagePane(): JSX.Element {
  const preference = useLocalePreference();

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-5 px-5 py-5">
      <SettingsHeading
        icon={<LanguageIcon className="size-4" />}
        title={t("settings.sections.language")}
      />
      <div className="flex">
        <div className="w-56">
          <Select.Root
            value={preference}
            onValueChange={(next) => setLocalePreference(next as LocalePreference)}
          >
            <Select.Trigger
              aria-label={t("settings.language.title")}
              className={FILTER_SELECT_TRIGGER_CLASS}
            >
              <span className="truncate">
                <Select.Value />
              </span>
              <Select.Icon>
                <ChevronDownIcon className="size-3.5 text-text-muted" />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content
                position="popper"
                sideOffset={4}
                data-dropdown-frame
                className={FILTER_SELECT_CONTENT_CLASS}
              >
                <Select.Viewport className="p-1">
                  {LOCALE_PREFERENCES.map((id) => (
                    <FilterSelectItem key={id} value={id}>
                      {t(`settings.language.${id}`)}
                    </FilterSelectItem>
                  ))}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        </div>
      </div>
    </section>
  );
}
