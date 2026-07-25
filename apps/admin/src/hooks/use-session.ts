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

export function useLogin() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.auth.login,
    onSuccess: (user) => {
      queryClient.setQueryData(['session'], user)
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
