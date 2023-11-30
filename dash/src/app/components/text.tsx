import cx from "classnames";
import { useState } from "react";
import { HiCheckCircle } from "react-icons/hi2";

import Status from "@/app/components/status";

const Text = ({
  text,
  onChange,
  disabled: isDisabled,
  onSubmit: handleSubmit,
}: {
  text: string;
  onChange: (text: string) => void;
  disabled: boolean;
  onSubmit: () => void | Promise<void>;
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-8">
      <div className="flex flex-col items-center gap-4">
        <Status />
        <div className="flex flex-col gap-1">
          <h1 className="text-center text-4xl">c&apos;mon, write something</h1>
          <h2 className="text-center text-xs text-gray-400">
            and maybe sign your name too
          </h2>
        </div>
      </div>
      <form
        className="flex w-full flex-col items-center gap-8"
        onSubmit={async (e) => {
          e.preventDefault();
          setIsSubmitting(true);
          await handleSubmit();
          setIsSubmitting(false);
        }}
      >
        <div className="flex w-full flex-col items-center gap-3">
          <div className="flex w-full flex-row">
            <div className="relative w-full">
              <input
                type="text"
                value={text}
                onChange={(e) => onChange(e.target.value)}
                className={cx(
                  "block h-12 w-full rounded-l-md border-0 py-1.5 pr-10 text-sm leading-6 ring-1 ring-inset focus:ring-2 focus:ring-inset",
                  isDisabled || isSubmitting
                    ? "text-gray-900 ring-gray-200 placeholder:text-gray-400 focus:ring-gray-200"
                    : "text-gray-900 ring-gray-200 placeholder:text-gray-400 focus:ring-green-600",
                )}
                placeholder="your cool message"
              />
            </div>
            <button
              type="submit"
              disabled={isDisabled || isSubmitting}
              className={cx(
                "rounded-r-md px-3 py-2 text-sm font-semibold text-white shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
                isDisabled || isSubmitting
                  ? "bg-gray-200"
                  : "bg-green-600 hover:bg-green-500 focus-visible:outline-green-600",
              )}
            >
              <HiCheckCircle className="h-5 w-5" />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};

export default Text;
