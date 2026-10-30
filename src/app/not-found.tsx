import Link from "next/link";

/**
 * Not found, for unmatched URLs and `notFound()` outside the admin (booking sites, sign-in pages).
 * Renders its own `<main>`: the root layout has none. `/app` pages use `(protected)/not-found.tsx`,
 * which keeps the admin shell.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-grey-50 px-5 py-10 font-sans text-grey-800">
      <div className="flex w-full max-w-[420px] flex-col gap-3">
        <h1 className="m-0 font-display text-[38px] leading-[0.98] font-extrabold text-navy-950">Page not found</h1>
        <p className="m-0 text-[16px] leading-normal text-grey-600">This page could not be found.</p>
        <Link
          href="/"
          className="mt-2 inline-flex min-h-11 items-center self-start font-semibold text-accent-text underline underline-offset-2 hover:text-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Go to the start
        </Link>
      </div>
    </main>
  );
}
