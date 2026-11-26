import { expect, it } from "vitest";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

const program = build({
  entryPoints: [new URL("./intlEnglish.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  platform: "neutral",
  format: "iife",
  globalName: "RuntimeIntl",
  target: "es2020",
}).then((result) => result.outputFiles[0].text);

it("preserves working native Intl constructors and system time zone", async () => {
  const code = await program;
  const result = runInNewContext(
    `const before={number:Intl.NumberFormat,date:Intl.DateTimeFormat,collator:Intl.Collator,zone:new Intl.DateTimeFormat().resolvedOptions().timeZone};${code};const configured=RuntimeIntl.configureIntlTimeZone("US/Eastern");[Intl.NumberFormat===before.number,Intl.DateTimeFormat===before.date,Intl.Collator===before.collator,configured.source,new Intl.DateTimeFormat().resolvedOptions().timeZone===before.zone];`,
  );
  expect(Array.from(result)).toEqual([true, true, true, "native", true]);
});

it("does not decode fallback collation tables when native Intl already works", async () => {
  const code = await program;
  const decoded = runInNewContext(`let largeDecodes=0;const parse=JSON.parse;
    JSON.parse=function(value,...args){if(typeof value==="string"&&value.length>100000)largeDecodes++;return parse(value,...args);};
    ${code};largeDecodes;`);
  expect(decoded).toBe(0);
});

it("fills a missing Intl runtime with actual number, calendar, collation and observed-zone behavior", async () => {
  const code = await program;
  const result = runInNewContext(`globalThis.Intl=undefined;${code};
    let missing=false;try{RuntimeIntl.configureIntlTimeZone();}catch(e){missing=e.code==="C23_TIME_ZONE";}
    const configured=RuntimeIntl.configureIntlTimeZone("US/Eastern");
    const clock=d=>new Intl.DateTimeFormat("en-US",{hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(d));
    const before=new Intl.DateTimeFormat().resolvedOptions().timeZone;
    let rejected=false;try{RuntimeIntl.configureIntlTimeZone("invalid/time-zone");}catch(e){rejected=e instanceof RangeError;}
    [missing,configured.source,new Intl.NumberFormat("en-US",{maximumFractionDigits:1}).format(1234.5),new Intl.NumberFormat("en",{style:"currency",currency:"USD"}).format(12.5),new Intl.NumberFormat("en",{notation:"compact",maximumFractionDigits:1}).format(12500),new Intl.DateTimeFormat("en",{month:"long",timeZone:"UTC"}).format(new Date("2026-11-06T12:00:00Z")),new Intl.Collator("en",{numeric:true,sensitivity:"base"}).compare("item2","item10")<0,clock("2026-03-08T06:59:00Z"),clock("2026-03-08T07:01:00Z"),new Date("2026-03-08T07:01:00Z").toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hourCycle:"h23"}),rejected,new Intl.DateTimeFormat().resolvedOptions().timeZone===before];`);
  expect(Array.from(result)).toEqual([
    true,
    "polyfill",
    "1,234.5",
    "$12.50",
    "12.5K",
    "November",
    true,
    "01:59",
    "03:01",
    "03:01",
    true,
    true,
  ]);
}, 15000);
