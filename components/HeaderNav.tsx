"use client"
import Link from 'next/link'
import Image from 'next/image'
import React, { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { ArrowRight, Zap } from 'lucide-react'
import { Show, SignInButton, SignUpButton, UserButton, useAuth } from '@clerk/nextjs'
import { Button } from '@/components/ui/button'
import PricingModal from './PricingModal'
import { PLANS } from '@/lib/constants'
import { Plan } from '@/types/plans'
import { cn } from '@/lib/utils'
import { getUserCredits } from '@/actions/user'

interface HeaderNavProps {
  credits: number | null
  plan: Plan | null
}

const HEADER_HEIGHT = 64

const HeaderNav = ({ credits: initialCredits, plan: initialPlan }: HeaderNavProps) => {
  const pathname = usePathname()
  const { isSignedIn } = useAuth()
  const [credits, setCredits] = useState<number | null>(initialCredits)
  const [plan, setPlan] = useState<Plan | null>(initialPlan)
  const isLanding = pathname === "/"
  const isPreview = pathname === "/preview" || pathname.startsWith("/preview/")
  const [pastHero, setPastHero] = useState(false)

  // Sync credits when initial props change
  useEffect(() => {
    if (initialCredits !== null) setCredits(initialCredits)
    if (initialPlan !== null) setPlan(initialPlan)
  }, [initialCredits, initialPlan])

  // Dynamically fetch credits on the client when signed in
  useEffect(() => {
    if (!isSignedIn) {
      setCredits(null)
      setPlan(null)
      return
    }

    let isMounted = true
    getUserCredits().then((data) => {
      if (isMounted && data) {
        setCredits(data.credits)
        setPlan(data.plan)
      }
    }).catch((err) => {
      console.error("[HeaderNav] failed to fetch credits:", err)
    })

    return () => {
      isMounted = false
    }
  }, [isSignedIn, pathname])

  useEffect(() => {
    if (!isLanding) return;

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

  if (isPreview) return null

  return (
    <header
      className={cn(
        "w-full fixed top-0 left-0 z-50 h-16 translate-z-0 transition-colors duration-200",
        transparentNav
          ? "border-transparent bg-transparent"
          : "border-b border-[#141414] bg-[#0a0a0a]"
      )}
    >
      <nav className='flex h-full w-full items-center justify-between px-4 sm:px-5'>
        <Link href='/' className='flex items-center gap-2'>
          <Image
            src="/logo-short2.svg"
            alt="Bloom"
            width={100}
            height={100}
            className="h-8 w-8 rounded-md"
          />
          <span className="font-serif text-lg tracking-tight text-white">
            Bloom
          </span>
        </Link>

        <div className='flex items-center gap-5'>
          <Show when="signed-in">
            <Link
              href={"/projects"}
              className="text-[13px] font-medium text-white/40 transition-colors hover:text-white/80"
            >
              Projects
            </Link>

            {credits !== null && plan && (
              <PricingModal>
                <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 text-xs text-white/70 cursor-pointer">
                  <Zap className="h-3 w-3 fill-white/70" />
                  {credits} / {PLANS[plan]?.credits ?? 10} credits
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
                className="text-white/40 hover:text-white/80"
              >
                Sign in
              </Button>
            </SignInButton>
            <SignUpButton mode="modal">
              <Button
                size="sm"
                className="h-8 rounded-full bg-violet-600 px-4 pt-0.5 font-semibold text-white hover:bg-violet-700 active:scale-95"
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
