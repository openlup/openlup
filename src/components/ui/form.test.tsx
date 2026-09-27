import { zodResolver } from "@hookform/resolvers/zod";
import { fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { z } from "../../lib/validation/zod.js";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "./form";
import { Input } from "./input";

const schema = z.object({
  email: z.string().trim().min(1, "forms:fields.email.required"),
});

type FormValues = z.infer<typeof schema>;

describe("Form infrastructure", () => {
  it("renders required labels and translates Zod/RHF message keys", async () => {
    render(<EmailDemo />);

    const input = screen.getByLabelText(/Email/);
    expect(screen.getByText("*")).toHaveAttribute("aria-hidden", "true");
    expect(input).toHaveAttribute("aria-describedby", expect.stringContaining("description"));

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Podaj adres email")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", expect.stringContaining("message"));
  });

  it("keeps human-readable messages unchanged when no translation key exists", async () => {
    render(<EmailDemo message="Already readable" />);

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Already readable")).toBeInTheDocument();
  });
});

function EmailDemo({ message = "forms:fields.email.required" }: { message?: string }) {
  const form = useForm<FormValues>({
    defaultValues: { email: "" },
    resolver: zodResolver(
      z.object({
        email: z.string().trim().min(1, message),
      }),
    ),
  });
  const onSubmit = vi.fn();

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Email</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormDescription>Opis pola</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <button type="submit">Submit</button>
      </form>
    </Form>
  );
}
