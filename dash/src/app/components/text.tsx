import cx from "classnames";
import { useState } from "react";

import Status from "@/app/components/status";

const PLACEHOLDERS = [
  "your cool message",
  "hello, world!",
  "type something here",
  "type something clever",
  "think real hard",
];

const getRandomPlaceholder = () =>
  PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];

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
    <div className="flex w-full max-w-2xl flex-col items-center gap-20">
      <div className="flex flex-col items-center gap-4">
        <Status />
        <div className="flex flex-col gap-1">
          <h1 className="text-center text-2xl">c&apos;mon, write something</h1>
          <h2 className="text-center text-xs text-gray-400">
            and maybe sign your name too
          </h2>
        </div>
      </div>
      <form
        className="mb-8 flex w-full flex-col items-center gap-8"
        onSubmit={async (e) => {
          e.preventDefault();
          setIsSubmitting(true);
          await handleSubmit();
          setIsSubmitting(false);
        }}
      >
        <div className="flex w-full flex-col items-center gap-3">
          <div className="flex w-full flex-row">
            <div className="relative w-full border-0 border-b-2">
              <input
                type="text"
                value={text}
                onChange={(e) => onChange(e.target.value)}
                className={cx(
                  "mb-2 block h-12 w-full border-none py-1.5 pr-10 text-center font-mono text-4xl font-light tracking-wider placeholder:font-mono placeholder:text-gray-200 focus:ring-0",
                  isDisabled || isSubmitting
                    ? "border-gray-200 text-gray-900 placeholder:text-gray-400 focus:border-gray-200"
                    : "border-gray-200 text-gray-900 placeholder:text-gray-400 focus:border-green-600",
                )}
                placeholder={getRandomPlaceholder()}
              />
            </div>
          </div>
        </div>
      </form>
    </div>
  );
};

export default Text;
