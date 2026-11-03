import React from "react";
import { Button as RadixButton, Checkbox, TextField, Theme } from "@radix-ui/themes";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import "@radix-ui/themes/styles.css";

export function DesignSystem({children, appearance = "dark"}: {children: React.ReactNode; appearance?: "light" | "dark"}) {
  return <Theme appearance={appearance} accentColor="blue" grayColor="slate" radius="large" scaling="100%" panelBackground="translucent">{children}</Theme>;
}
export function Button({className = "", type, ...props}: React.ComponentPropsWithoutRef<"button">) {
  const plain = /(?:icon-btn|text-btn|task-row|project-link|workspace|send)/.test(className);
  return <RadixButton {...props} type={type ?? "submit"} className={className} variant={className.includes("primary") ? "solid" : plain ? "ghost" : "surface"} color={className.includes("danger") ? "red" : undefined} size="2"/>;
}
type InputProps = Pick<React.InputHTMLAttributes<HTMLInputElement>, "required" | "readOnly" | "placeholder" | "autoFocus" | "min" | "max" | "className" | "disabled" | "name" | "id" | "aria-label"> & {
  type?: "checkbox" | "number" | "text"; value?: string | number; checked?: boolean;
  onChange?: (event: {target: {value: string; checked: boolean}}) => void;
};
export function Input({type, checked, onChange, ...props}: InputProps) {
  if (type === "checkbox") return <Checkbox checked={checked} disabled={props.disabled} required={props.required} name={props.name} id={props.id} aria-label={props["aria-label"]} className={props.className} onCheckedChange={next => onChange?.({target: {checked: next === true, value: String(props.value ?? "on")}})} />;
  return <TextField.Root {...props} type={type === "number" ? "number" : "text"} onChange={event => onChange?.(event)}/>;
}
export function Modal({title,close,children}: {title: string;close: () => void;children: React.ReactNode}) {
  return <Dialog.Root open onOpenChange={open => {if (!open) close();}}><Dialog.Portal><Dialog.Overlay className="modal-backdrop"/><Dialog.Content className="modal" aria-describedby={undefined}><div className="section-title"><Dialog.Title asChild><h2>{title}</h2></Dialog.Title><Button type="button" className="icon-btn" onClick={close} aria-label="关闭对话框"><X size={18}/></Button></div>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}
