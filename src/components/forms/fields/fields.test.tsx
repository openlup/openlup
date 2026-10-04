import { zodResolver } from "@hookform/resolvers/zod";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { z } from "../../../lib/validation/zod.js";
import { Form } from "@/components/ui/form";
import { CompanyField } from "./CompanyField";
import { ConsentField } from "./ConsentField";
import { EmailField } from "./EmailField";
import { NameField } from "./NameField";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => {
    const messages: Record<string, string> = {
      "forms:fields.name.label": "Synthetic name",
      "forms:fields.name.placeholder": "Example Person",
      "forms:fields.name.required": "Name required",
      "forms:fields.email.label": "Synthetic email",
      "forms:fields.email.placeholder": "person@example.test",
      "forms:fields.email.required": "Email required",
      "forms:fields.company.label": "Synthetic company",
      "forms:fields.company.placeholder": "Example Company",
      "forms:fields.company.required": "Company required",
      "forms:fields.consent.label": "Synthetic consent",
      "forms:fields.consent.required": "Consent required"
};
    return messages[key] ?? key;
  } }),
}));

const schema = z.object({
  name: z.string().trim().min(1, "forms:fields.name.required"),
  email: z.string().trim().min(1, "forms:fields.email.required"),
  company: z.string().trim().min(1, "forms:fields.company.required"),
  consent: z.boolean().refine(Boolean, "forms:fields.consent.required"),
});

type FieldValues = z.infer<typeof schema>;

describe("canonical form field components", () => {
  it("renders text fields with translated labels, placeholders and required markers", async () => {
    render(<FieldsDemo />);

    expect(screen.getByLabelText(/Synthetic name/)).toHaveAttribute("placeholder", "Example Person");
    expect(screen.getByLabelText(/Synthetic email/)).toHaveAttribute("type", "email");
    expect(screen.getByLabelText(/Synthetic company/)).toHaveAttribute("placeholder", "Example Company");
    expect(screen.getAllByText("*")).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Name required")).toBeInTheDocument();
    expect(screen.getByText("Email required")).toBeInTheDocument();
    expect(screen.getByText("Company required")).toBeInTheDocument();
    expect(screen.getByText("Consent required")).toBeInTheDocument();
    expect(screen.getByLabelText(/Synthetic email/)).toHaveAttribute("aria-invalid", "true");
  });

  it("submits checkbox consent as a boolean", async () => {
    const onSubmit = vi.fn();
    render(<FieldsDemo onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/Synthetic name/), {
      target: { value: "Anna Nowak" },
    });
    fireEvent.change(screen.getByLabelText(/Synthetic email/), {
      target: { value: "anna@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/Synthetic company/), {
      target: { value: "openlup" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Synthetic consent/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        {
          company: "openlup",
          consent: true,
          email: "anna@example.com",
          name: "Anna Nowak",
        },
        expect.anything(),
      );
    });
  });
});

function FieldsDemo({ onSubmit = vi.fn() }: { onSubmit?: (values: FieldValues) => void }) {
  const form = useForm<FieldValues>({
    defaultValues: {
      company: "",
      consent: false,
      email: "",
      name: "",
    },
    resolver: zodResolver(schema),
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <NameField control={form.control} name="name" required />
        <EmailField control={form.control} name="email" required />
        <CompanyField control={form.control} name="company" required />
        <ConsentField control={form.control} name="consent" required />
        <button type="submit">Submit</button>
      </form>
    </Form>
  );
}
