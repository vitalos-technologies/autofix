import { cn } from "@/lib/utils";
import type { FormAction } from "./types";

/** Field name of the search box. */
export const ADMIN_SEARCH_FIELD = "q";

export const DEFAULT_SEARCH_PLACEHOLDER = "Search reg, customer or booking ref";

export type AdminSearchProps = {
  /**
   * Posted with `method="post"` (or run as a server action). Never a GET form: searches are often
   * a registration, and registrations must not go in URLs (CLAUDE.md rule 3).
   */
  action: FormAction;
  placeholder?: string;
  id: string;
  className?: string;
};

/** Search box for the admin top bar (and the phone header). */
export function AdminSearch({ action, placeholder = DEFAULT_SEARCH_PLACEHOLDER, id, className }: AdminSearchProps) {
  return (
    <form
      role="search"
      method={typeof action === "string" ? "post" : undefined}
      action={action}
      className={cn("relative flex min-w-0", className)}
    >
      <label htmlFor={id} className="sr-only">
        Search
      </label>
      <input
        id={id}
        name={ADMIN_SEARCH_FIELD}
        type="search"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        placeholder={placeholder}
        className={cn(
          "h-11 w-full min-w-0 rounded-[10px] border border-[#dbe3ec] bg-[#f7f9fb] px-3.5 font-sans text-[14px] text-navy-950",
          "placeholder:text-grey-600 focus-visible:border-accent focus-visible:bg-white focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent",
        )}
      />
    </form>
  );
}
