import Link from 'next/link'
import Image from 'next/image'
import React from 'react'

const Header = () => {
  return <header>
    <nav>
        <Link href='/'>
        <Image
            src={"/logo-2.png"}
            alt="Forge Logo"
            width={100}
            height={100}
            className="h-9 w-auto rounded-md"
        />
        </Link>
    </nav>
  </header>
}

export default Header