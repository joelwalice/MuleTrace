import type { Metadata } from "next";
import SendForm from "./send-form";

export const metadata: Metadata = {
  title: "Send a Transfer · MuleTrace",
  description: "Send a transfer into the live MuleTrace bank and see whether the rules catch it.",
};

export default function SendPage() {
  return <SendForm />;
}
