import { useEffect, useState } from "react";

import { Input } from "@/components/input";
import { Button } from "@/components/button";

const PLACEHOLDERS = [
  "your cool message",
  "hello, world!",
  "type something here",
  "type something clever",
  "think real hard",
];

const getRandomPlaceholder = () =>
  PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];

const Message = ({
  message,
  onChange,
  disabled: isDisabled,
  onSubmit: handleSubmit,
}: {
  message: string;
  onChange: (text: string) => void;
  disabled: boolean;
  onSubmit: () => void | Promise<void>;
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [placeholder, setPlaceholder] = useState("");

  useEffect(() => {
    setPlaceholder(getRandomPlaceholder());
  }, []);

  return (
    <form
      className="row flex w-full max-w-2xl items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setIsSubmitting(true);
        await handleSubmit();
        setIsSubmitting(false);
      }}
    >
      <Input
        type="text"
        value={message}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={isSubmitting}
      />
      <Button
        type="submit"
        disabled={isDisabled || isSubmitting}
        className="w-32"
      >
        Submit
      </Button>
    </form>
  );
};

export default Message;
