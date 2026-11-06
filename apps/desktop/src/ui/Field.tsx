import {
  cloneElement,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Check } from "lucide-react";

type ControlProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
};

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  connect = true,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
  connect?: boolean;
  className?: string;
}) {
  const generatedId = useId();
  const id = htmlFor ?? generatedId;
  const messageId = `${id}-message`;
  const child =
    connect && isValidElement<ControlProps>(children)
      ? (children as ReactElement<ControlProps>)
      : undefined;
  const controlId = child?.props.id ?? id;
  const control = child
    ? cloneElement(child, {
        id: controlId,
        "aria-describedby":
          [child.props["aria-describedby"], hint || error ? messageId : ""]
            .filter(Boolean)
            .join(" ") || undefined,
        "aria-invalid": error ? true : child.props["aria-invalid"],
      })
    : children;
  return (
    <div className={`ui-field${error ? " ui-field--invalid" : ""}${className ? ` ${className}` : ""}`}>
      <label className="ui-field__label" htmlFor={controlId}>
        {label}
      </label>
      {control}
      {(error || hint) && (
        <p className={error ? "ui-field__error" : "ui-field__hint"} id={messageId}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

export function TextInput({
  className,
  invalid,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...props}
      className={["ui-input", invalid ? "ui-input--invalid" : "", className]
        .filter(Boolean)
        .join(" ")}
    />
  );
}

export function TextArea({
  className,
  invalid,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      {...props}
      className={[
        "ui-input",
        "ui-textarea",
        invalid ? "ui-input--invalid" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}

export function Select({
  className,
  invalid,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      {...props}
      className={[
        "ui-input",
        "ui-select",
        invalid ? "ui-input--invalid" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}

export function Checkbox({
  label,
  description,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode;
  description?: ReactNode;
}) {
  return (
    <label className={["ui-checkbox", className].filter(Boolean).join(" ")}>
      <input {...props} type="checkbox" />
      <span className="ui-checkbox__box" aria-hidden="true">
        <Check size={12} />
      </span>
      <span className="ui-checkbox__copy">
        <span>{label}</span>
        {description && <small>{description}</small>}
      </span>
    </label>
  );
}

export function Toggle({
  label,
  description,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: ReactNode;
  description?: ReactNode;
}) {
  return (
    <label className={["ui-toggle", className].filter(Boolean).join(" ")}>
      <input {...props} type="checkbox" role="switch" />
      <span className="ui-toggle__track" aria-hidden="true">
        <span className="ui-toggle__thumb" />
      </span>
      <span className="ui-toggle__copy">
        <span>{label}</span>
        {description && <small>{description}</small>}
      </span>
    </label>
  );
}
