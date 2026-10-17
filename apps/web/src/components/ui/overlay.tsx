import * as React from "react";
import * as DialogP from "@radix-ui/react-dialog";
import * as TooltipP from "@radix-ui/react-tooltip";
import * as PopoverP from "@radix-ui/react-popover";
import * as DropdownP from "@radix-ui/react-dropdown-menu";
import * as SelectP from "@radix-ui/react-select";
import * as TabsP from "@radix-ui/react-tabs";
import * as SwitchP from "@radix-ui/react-switch";
import * as CheckboxP from "@radix-ui/react-checkbox";
import * as SliderP from "@radix-ui/react-slider";
import * as ScrollP from "@radix-ui/react-scroll-area";
import { Check, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

/* ---------------- Dialog / Sheet ---------------- */
export const Dialog = DialogP.Root;
export const DialogTrigger = DialogP.Trigger;
export const DialogClose = DialogP.Close;
export function DialogContent({ title, description, children, className, side }: { title: string; description?: string; children: React.ReactNode; className?: string; side?: "right" | "bottom" }) {
  return (
    <DialogP.Portal>
      <DialogP.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_.15s_ease-out]" />
      <DialogP.Content className={cn("fixed z-50 flex flex-col border border-line bg-surface shadow-[var(--shadow-pop)] outline-none",
        side === "right" ? "inset-y-0 right-0 w-full max-w-lg rounded-l-2xl" : side === "bottom" ? "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-2xl safe-b" : "left-1/2 top-1/2 max-h-[88dvh] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-2xl", className)}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0"><DialogP.Title className="text-base font-semibold tracking-tight">{title}</DialogP.Title>{description ? <DialogP.Description className="mt-1 text-[13px] text-muted">{description}</DialogP.Description> : <DialogP.Description className="sr-only">{title}</DialogP.Description>}</div>
          <DialogP.Close className="rounded-md p-1 text-muted transition hover:bg-overlay hover:text-fg" aria-label="Close"><X className="size-4" /></DialogP.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </DialogP.Content>
    </DialogP.Portal>
  );
}

/* ---------------- Tooltip ---------------- */
export const TooltipProvider = ({ children }: { children: React.ReactNode }) => <TooltipP.Provider delayDuration={250} skipDelayDuration={100}>{children}</TooltipP.Provider>;
export function Tip({ label, children, side = "right" }: { label: React.ReactNode; children: React.ReactElement; side?: "top" | "right" | "bottom" | "left" }) {
  return <TooltipP.Root><TooltipP.Trigger asChild>{children}</TooltipP.Trigger><TooltipP.Portal><TooltipP.Content side={side} sideOffset={8} className="z-[60] max-w-xs rounded-md border border-line-strong bg-overlay px-2.5 py-1.5 text-xs text-fg shadow-[var(--shadow-pop)] animate-in">{label}</TooltipP.Content></TooltipP.Portal></TooltipP.Root>;
}

/* ---------------- Popover ---------------- */
export const Popover = PopoverP.Root;
export const PopoverTrigger = PopoverP.Trigger;
export const PopoverContent = ({ className, align = "start", ...p }: React.ComponentProps<typeof PopoverP.Content>) => <PopoverP.Portal><PopoverP.Content align={align} sideOffset={6} className={cn("z-50 w-72 rounded-xl border border-line bg-elevated p-3 shadow-[var(--shadow-pop)] outline-none animate-in", className)} {...p} /></PopoverP.Portal>;

/* ---------------- Dropdown ---------------- */
export const Dropdown = DropdownP.Root;
export const DropdownTrigger = DropdownP.Trigger;
export const DropdownContent = ({ className, align = "end", ...p }: React.ComponentProps<typeof DropdownP.Content>) => <DropdownP.Portal><DropdownP.Content align={align} sideOffset={6} className={cn("z-50 min-w-44 rounded-xl border border-line bg-elevated p-1 shadow-[var(--shadow-pop)] animate-in", className)} {...p} /></DropdownP.Portal>;
export const DropdownItem = ({ className, danger, ...p }: React.ComponentProps<typeof DropdownP.Item> & { danger?: boolean }) => <DropdownP.Item className={cn("flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none data-[highlighted]:bg-overlay", danger ? "text-bad" : "text-fg", className)} {...p} />;
export const DropdownSep = () => <DropdownP.Separator className="my-1 h-px bg-line" />;
export const DropdownLabel = ({ children }: { children: React.ReactNode }) => <DropdownP.Label className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">{children}</DropdownP.Label>;

/* ---------------- Select ---------------- */
export function Select({ value, onValueChange, options, placeholder, className, disabled }: { value?: string; onValueChange: (v: string) => void; options: { value: string; label: React.ReactNode; hint?: string; disabled?: boolean }[]; placeholder?: string; className?: string; disabled?: boolean }) {
  return (
    <SelectP.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectP.Trigger className={cn("inline-flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-bg px-3 text-sm text-fg transition hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-50 data-[placeholder]:text-faint", className)}>
        <span className="truncate"><SelectP.Value placeholder={placeholder} /></span><SelectP.Icon><ChevronDown className="size-4 text-muted" /></SelectP.Icon>
      </SelectP.Trigger>
      <SelectP.Portal><SelectP.Content position="popper" sideOffset={6} className="z-[70] max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border border-line bg-elevated shadow-[var(--shadow-pop)] animate-in"><SelectP.Viewport className="p-1">
        {options.map((o) => <SelectP.Item key={o.value} value={o.value} disabled={o.disabled} className="relative flex cursor-pointer select-none items-center gap-2 rounded-lg py-2 pl-8 pr-3 text-[13px] outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-overlay"><span className="absolute left-2.5 grid size-4 place-items-center"><SelectP.ItemIndicator><Check className="size-3.5 text-accent" /></SelectP.ItemIndicator></span><SelectP.ItemText>{o.label}</SelectP.ItemText>{o.hint && <span className="ml-auto text-[11px] text-faint">{o.hint}</span>}</SelectP.Item>)}
      </SelectP.Viewport></SelectP.Content></SelectP.Portal>
    </SelectP.Root>
  );
}

/* ---------------- Tabs ---------------- */
export const Tabs = TabsP.Root;
export const TabsList = ({ className, ...p }: React.ComponentProps<typeof TabsP.List>) => <TabsP.List className={cn("flex items-center gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]", className)} {...p} />;
export const TabsTrigger = ({ className, ...p }: React.ComponentProps<typeof TabsP.Trigger>) => <TabsP.Trigger className={cn("relative -mb-px shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-[13px] font-medium text-muted outline-none transition hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg", className)} {...p} />;
export const TabsContent = ({ className, ...p }: React.ComponentProps<typeof TabsP.Content>) => <TabsP.Content className={cn("outline-none animate-in", className)} {...p} />;

/* ---------------- Switch / Checkbox / Slider ---------------- */
export const Switch = ({ className, ...p }: React.ComponentProps<typeof SwitchP.Root>) => <SwitchP.Root className={cn("inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-line bg-overlay transition data-[state=checked]:border-accent data-[state=checked]:bg-accent", className)} {...p}><SwitchP.Thumb className="block size-4 translate-x-0.5 rounded-full bg-fg shadow transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-accent-fg" /></SwitchP.Root>;
export const Checkbox = ({ className, ...p }: React.ComponentProps<typeof CheckboxP.Root>) => <CheckboxP.Root className={cn("grid size-[18px] shrink-0 place-items-center rounded-md border border-line-strong bg-bg transition data-[state=checked]:border-accent data-[state=checked]:bg-accent", className)} {...p}><CheckboxP.Indicator><Check className="size-3 text-accent-fg" strokeWidth={3} /></CheckboxP.Indicator></CheckboxP.Root>;
export const Slider = ({ className, ...p }: React.ComponentProps<typeof SliderP.Root>) => <SliderP.Root className={cn("relative flex h-5 w-full touch-none select-none items-center", className)} {...p}><SliderP.Track className="relative h-1.5 grow rounded-full bg-overlay"><SliderP.Range className="absolute h-full rounded-full bg-accent" /></SliderP.Track><SliderP.Thumb className="block size-4 rounded-full border-2 border-accent bg-bg shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" /></SliderP.Root>;
export function ToggleRow({ title, desc, checked, onChange, disabled }: { title: string; desc?: React.ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <div className="flex items-start justify-between gap-4 py-2.5"><div className="min-w-0"><p className="text-sm font-medium">{title}</p>{desc && <p className="mt-0.5 text-xs leading-relaxed text-muted">{desc}</p>}</div><Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={title} /></div>;
}

/* ---------------- ScrollArea ---------------- */
export const ScrollArea = ({ className, children, ...p }: React.ComponentProps<typeof ScrollP.Root>) => <ScrollP.Root className={cn("overflow-hidden", className)} {...p}><ScrollP.Viewport className="size-full [&>div]:!block">{children}</ScrollP.Viewport><ScrollP.Scrollbar orientation="vertical" className="flex w-2 touch-none p-0.5"><ScrollP.Thumb className="relative flex-1 rounded-full bg-line-strong" /></ScrollP.Scrollbar></ScrollP.Root>;
