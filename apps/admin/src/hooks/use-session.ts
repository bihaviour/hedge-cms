import type { User } from '@hedge/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiClientError, api } from '@/lib/api'

/**
 * The signed-in user, or `null` when unauthenticated. A 401 is an expected answer here,
 * not an error — it just means "show the login screen".
 */
export function useSession() {
  return useQuery<User | null>({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        return await api.auth.me()
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 401) return null
        throw error
      }
    },
  })
}

export function useSetupRequired() {
  return useQuery({
    queryKey: ['setup-required'],
    queryFn: () => api.auth.setupRequired(),
    staleTime: Number.POSITIVE_INFINITY,
  })
}

/**
 * Signing in. The result is a union: a password can be correct and still not produce a session,
 * because a browser the account has not been seen on is mailed a code first. Only the completed
 * case seeds the session cache — the pending one has no user to seed it with.
 */
export function useLogin() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.auth.login,
    onSuccess: (result) => {
      if (result.verificationRequired) return
      queryClient.setQueryData(['session'], result.user)
      queryClient.invalidateQueries()
    },
  })
}

/** The second step of a sign-in: the mailed code. Succeeding here is what produces the session. */
export function useVerifyLoginCode() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.auth.verifyLoginCode,
    onSuccess: (result) => {
      if (result.verificationRequired) return
      queryClient.setQueryData(['session'], result.user)
      queryClient.invalidateQueries()
    },
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.auth.logout,
    onSuccess: () => {
      queryClient.setQueryData(['session'], null)
      queryClient.clear()
    },
  })
}
