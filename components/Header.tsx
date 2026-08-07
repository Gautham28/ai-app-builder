import React from 'react'
import HeaderNav from './HeaderNav'
import { checkUser } from '@/lib/checkUser'
import { Plan } from '@/types/plans'


const Header = async () => {
  const user = await checkUser();

  return (
    <HeaderNav
      credits={user?.credits ?? null}
      plan={(user?.plan as Plan) ?? null}
    />
  )
}

export default Header
