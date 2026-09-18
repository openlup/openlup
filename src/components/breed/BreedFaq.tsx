import { motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import type { AudienceSegment } from "@/domains/catalog/audienceModel";
import { useFadeUpProps } from "@/lib/animations";

const BreedFaq = ({ breed }: { breed: AudienceSegment }) => {
  const fade = useFadeUpProps();

  return (
    <section className="bg-light-teal px-6 lg:px-[72px] py-20 max-md:py-14">
              <div className="max-w-[760px] mx-auto">
                <motion.h2
                  {...fade}
                  className="font-display font-semibold text-display-sm lg:text-display-lg text-teal-dark leading-none text-center mb-12"
                >
                  {`Najczęstsze pytania o karmę dla ${breed.gen}`}
                </motion.h2>
                <div className="space-y-3">
                  {breed.faq.map((item) => (
                    <details key={item.q} className="group bg-white rounded-xl border border-border shadow-xs overflow-hidden">
                      <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
                        <span className="font-body font-semibold text-sm-plus lg:text-base text-teal-dark leading-snug">
                          {item.q}
                        </span>
                        <ChevronDown
                          aria-hidden="true"
                          className="w-5 h-5 text-muted-foreground shrink-0 transition-transform duration-200 group-open:rotate-180"
                        />
                      </summary>
                      <div className="px-6 pb-5 pt-0">
                        <p className="font-body text-sm lg:text-sm-plus text-charcoal/70 leading-[1.75]">{item.a}</p>
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            </section>
  );
};

export default BreedFaq;
