"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { parsePatch } from "@/lib/patch";
import type { Task } from "@/lib/tasks";

export function TaskDiff({ task }: { task: Task }) {
  const files = parsePatch(task.result?.patch || "");
  const [open, setOpen] = useState<string[]>(files.length ? ["0"] : []);
  return (
    <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="space-y-5 lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto">
        <p className="text-body">
          Files changed <span className="float-right text-muted-foreground">{files.length}</span>
        </p>
        <div className="flex flex-col gap-2">
          {files.map((file, index) => (
            <Button
              key={index}
              variant="ghost"
              className="justify-start font-mono w-full min-w-0"
              active={open.includes(String(index))}
              onClick={() => {
                setOpen((current) =>
                  current.includes(String(index)) ? current : [...current, String(index)],
                );
                document
                  .getElementById(`patch-file-${index}`)
                  ?.scrollIntoView({ block: "nearest" });
              }}
            >
              <span className="truncate">{file.path}</span>{" "}
              <span className="ml-2 text-muted-foreground">{file.status}</span>
            </Button>
          ))}
        </div>
        <p className="border-t border-border pt-5 text-caption text-muted-foreground">
          Compared with source commit
          <br />
          <code className="mt-3 block">{task.sourceSha?.slice(0, 7) || "unavailable"}</code>
        </p>
      </aside>
      <div className="min-w-0">
        {files.length ? (
          <Accordion
            type="multiple"
            value={open}
            onValueChange={(value: string[]) => setOpen(value)}
            className="w-full space-y-4"
          >
            {files.map((file, index) => (
              <AccordionItem
                key={index}
                value={String(index)}
                id={`patch-file-${index}`}
                className="rounded-xl border border-border bg-card overflow-hidden"
              >
                <AccordionTrigger className="font-mono">
                  <span className="flex w-full items-center justify-between gap-4">
                    <span className="break-all">{file.path}</span>
                    <span className="shrink-0 text-caption">
                      <span className="text-green-700 dark:text-green-400">+{file.additions}</span>{" "}
                      <span className="text-red-700 dark:text-red-400">−{file.deletions}</span>
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="overflow-x-auto border-t border-border">
                    <pre className="min-w-max py-2 font-mono text-caption">
                      {file.lines.map((line, i) => (
                        <div
                          key={i}
                          className={`flex ${line.kind === "addition" ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-300" : line.kind === "deletion" ? "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300" : line.kind === "meta" ? "text-muted-foreground" : ""}`}
                        >
                          <span aria-hidden className="w-10 shrink-0 select-none pr-2 text-right">
                            {line.oldLine}
                          </span>
                          <span aria-hidden className="w-10 shrink-0 select-none pr-2 text-right">
                            {line.newLine}
                          </span>
                          <span aria-hidden className="w-5 shrink-0 select-none">
                            {line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}
                          </span>
                          <span className="pr-4">{line.text || " "}</span>
                        </div>
                      ))}
                    </pre>
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        ) : (
          <p className="note">No patch was provided.</p>
        )}
      </div>
    </div>
  );
}
