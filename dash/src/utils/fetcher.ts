import { z } from "zod";

const fetcher = async (key: string) =>
  await fetch(`https://driver.led.ziyadedher.com:9000${key}`, {
    cache: "no-store",
  });

const constructFetcherWithSchema =
  <Output>(schema: z.ZodSchema<Output>): ((key: string) => Promise<Output>) =>
  async (key: string) =>
    await schema.parseAsync(await (await fetcher(key)).json());

export default fetcher;
export { constructFetcherWithSchema };
