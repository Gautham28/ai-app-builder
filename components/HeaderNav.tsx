"use client"
import Link from 'next/link'
import Image from 'next/image'
import React, { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { ArrowRight, Zap } from 'lucide-react'
import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs'
import { Button } from '@/components/ui/button'
import PricingModal from './PricingModal'
import { PLANS } from '@/lib/constants'
import { Plan } from '@/types/plans'
import { cn } from '@/lib/utils'

interface HeaderNavProps {
  credits: number | null
  plan: Plan | null
}

const HEADER_HEIGHT = 64

const HeaderNav = ({ credits, plan }: HeaderNavProps) => {
  const pathname = usePathname()
  const isLanding = pathname === "/"
  const [pastHero, setPastHero] = useState(false)

  useEffect(() => {
    if (!isLanding) {
      setPastHero(false)
      return
    }

    const hero = document.getElementById("hero")
    if (!hero) return

    let rafId = 0
    let past = false

    const update = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        const next = hero.getBoundingClientRect().bottom <= HEADER_HEIGHT
        if (next !== past) {
          past = next
          setPastHero(next)
        }
      })
    }

    update()
    window.addEventListener("scroll", update, { passive: true })
    window.addEventListener("resize", update, { passive: true })
    return () => {
      window.removeEventListener("scroll", update)
      window.removeEventListener("resize", update)
      cancelAnimationFrame(rafId)
    }
  }, [isLanding])

  const transparentNav = isLanding && !pastHero

  return (
    <header
      className={cn(
        "w-full fixed top-0 left-0 z-50 h-16 translate-z-0 transition-colors duration-200",
        transparentNav
          ? "border-transparent bg-transparent"
          : isLanding
            ? "border-b border-black/5 bg-white"
            : "border-b border-[#141414] bg-[#0a0a0a]"
      )}
    >
      <nav className='mx-auto flex h-full max-w-7xl items-center justify-between px-4 sm:px-6'>
        <Link href='/' className='flex items-center gap-2'>
          <Image
            src={isLanding ? "/logo-short.svg" : "/logo-short2.svg"}
            alt="Bloom"
            width={100}
            height={100}
            className="h-8 w-8 rounded-md"
          />
          <span
            className={cn(
              "font-serif text-lg tracking-tight",
              isLanding ? "text-neutral-900" : "text-white"
            )}
          >
            Bloom
          </span>
        </Link>

        <div className='flex items-center gap-5'>
          <Show when="signed-in">
            <Link
              href={"/projects"}
              className={cn(
                "text-[13px] font-medium transition-colors",
                isLanding
                  ? "text-neutral-500 hover:text-neutral-900"
                  : "text-white/40 hover:text-white/80"
              )}
            >
              Projects
            </Link>

            {credits !== null && plan && (
              <PricingModal>
                <span
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs",
                    isLanding
                      ? "border-neutral-200 bg-white text-neutral-600"
                      : "border-white/10 bg-white/5 text-white/70"
                  )}
                >
                  <Zap
                    className={cn(
                      "h-3 w-3",
                      isLanding ? "fill-violet-600 text-violet-600" : "fill-white/70"
                    )}
                  />
                  {credits} / {PLANS[plan].credits} credits
                </span>
              </PricingModal>
            )}

            <UserButton />
          </Show>

          <Show when="signed-out">
            <SignInButton mode="modal">
              <Button
                variant="ghost"
                size="sm"
                className={isLanding ? "text-neutral-600 hover:text-neutral-900" : "text-white/40"}
              >
                Sign in
              </Button>
            </SignInButton>
            <SignUpButton mode="modal">
              <Button
                size="sm"
                className={cn(
                  "h-8 rounded-full font-semibold active:scale-95 px-4 pt-0.5",
                  isLanding && "bg-violet-600 text-white hover:bg-violet-700"
                )}
              >
                Get Started
                <ArrowRight className='h-3 w-3 opacity-60' />
              </Button>
            </SignUpButton>
          </Show>
        </div>
      </nav>
    </header>
  )
}

export default HeaderNav
