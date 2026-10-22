import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

import { ListHeader } from "../list-header"

export default function Loading() {
  return (
    <>
      <ListHeader title="Admin" />
      <div className="flex flex-col gap-6 p-4">
        {[3, 3].map((rows, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-2/3" />
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {Array.from({ length: rows }, (_, j) => (
                <Skeleton key={j} className="h-7 w-full" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  )
}
